"""Figure processing wrapper for ChunkingTests.

Wraps PolicyAsCode's FigureProcessor to handle image processing,
result serialization, and storage of annotated images and JSON results.

Supports two-stage processing:
1. SAM3 Segmentation - Quick visual inspection of shape detection
2. Mermaid Extraction - Structure extraction + mermaid generation using SAM3 results
"""

from __future__ import annotations

import json
import shutil
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Any

from loguru import logger

if TYPE_CHECKING:
    from src.figure_processing import FigureProcessor


class FigureProcessorWrapper:
    """Wrapper for PolicyAsCode's FigureProcessor with result persistence."""

    def __init__(self) -> None:
        """Initialize the processor lazily to avoid import overhead."""
        self._processor: FigureProcessor | None = None

    def _get_processor(self) -> FigureProcessor:
        """Lazy-load the FigureProcessor from PolicyAsCode."""
        if self._processor is None:
            try:
                from src.config.settings import settings
                from src.figure_processing import FigureProcessor
                from src.processors.structured_client import create_client

                # Create separate client for mermaid generation (text-only with no reasoning)
                mermaid_client = create_client(
                    model=settings.mermaid_model,
                    context="FigureProcessor_mermaid"
                )

                self._processor = FigureProcessor(
                    mermaid_client=mermaid_client
                )
                logger.info("FigureProcessor initialized from PolicyAsCode with separate mermaid client")
            except ImportError as e:
                raise ImportError(
                    "FigureProcessor not available. Ensure PolicyAsCode is installed "
                    "from the feature/figure-vision-pr5c-api-endpoints branch."
                ) from e
        return self._processor

    def process_figure(
        self,
        image_path: str | Path,
        ocr_text: str = "",
        *,
        run_id: str | None = None,
        text_positions: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        """Process a single figure image through the vision pipeline.

        Args:
            image_path: Path to the figure image (PNG/JPEG)
            ocr_text: OCR text extracted from the figure (if available)
            run_id: Optional run identifier for tracking
            text_positions: Text position data for SAM3 annotations

        Returns:
            Dict containing:
                - figure_type: Classification (flowchart/other)
                - confidence: Classification confidence score
                - processed_content: Mermaid code for flowcharts, description otherwise
                - raw_ocr_text: Original OCR text
                - description: Figure description
                - processing_notes: Any notes from processing
                - step1_duration_ms: Classification time
                - step2_duration_ms: Structure/Mermaid generation time
        """
        from src.figure_processing import FigureProcessor as PolicyFigureProcessor
        from src.figure_processing import FigureType
        from src.figure_processing import FigureClassification

        processor = self._get_processor()
        image_path = Path(image_path)

        # Classify first to determine if SAM3 annotations are needed
        classification = processor.classify_figure(image_path, ocr_text=ocr_text)

        shape_positions = None
        processing_image_path = image_path

        if classification.figure_type in PolicyFigureProcessor.FLOWCHART_TYPES:
            # Detect flow direction for SAM3
            direction = "LR"
            try:
                from src.prompts.figure_direction_prompt import detect_direction

                direction_result = detect_direction(image_path)
                direction = direction_result.direction.value
                logger.debug(f"Detected flow direction: {direction}")
            except Exception as e:
                logger.warning(f"Direction detection failed, using default LR: {e}")

            # Use processor's segment_and_annotate directly (PaC Facade pattern)
            try:
                annotated_path, shape_positions, _ = processor.segment_and_annotate(
                    image_path,
                    text_positions=text_positions,
                    direction=direction,
                )

                if annotated_path and shape_positions:
                    processing_image_path = annotated_path
                    logger.info(
                        f"SAM3 annotations prepared: {len(shape_positions)} shapes"
                    )
                else:
                    # SAM3 didn't return positions - fall back to "other" type
                    logger.warning("SAM3 returned no shape positions, treating as non-flowchart")
                    classification = FigureClassification(
                        figure_type=FigureType.OTHER,
                        confidence=classification.confidence,
                        reasoning="SAM3 annotation failed, treating as non-flowchart",
                    )
            except Exception as e:
                # SAM3 failed - fall back to "other" type
                logger.warning(f"SAM3 annotation failed: {e}, treating as non-flowchart")
                classification = FigureClassification(
                    figure_type=FigureType.OTHER,
                    confidence=classification.confidence,
                    reasoning=f"SAM3 annotation failed: {e}",
                )

        # Call processor with shape_positions (if flowchart) and force_type
        result = processor.process_figure(
            image_path=processing_image_path,
            ocr_text=ocr_text,
            shape_positions=shape_positions,
            text_positions=text_positions,
            run_id=run_id,
            force_type=classification.figure_type,
        )
        return result.model_dump()

    def classify_figure(
        self,
        image_path: str | Path,
        ocr_text: str = "",
    ) -> dict[str, Any]:
        """Classify a figure without full processing.

        Args:
            image_path: Path to the figure image
            ocr_text: OCR text for additional context

        Returns:
            Dict with figure_type, confidence, and reasoning
        """
        processor = self._get_processor()
        result = processor.classify_figure(Path(image_path), ocr_text=ocr_text)
        return result.model_dump()

    def classify_only(
        self,
        image_path: str | Path,
        ocr_text: str = "",
        *,
        run_id: str | None = None,
    ) -> dict[str, Any]:
        """Run classification only (fast, automatic step).

        This is designed to be called immediately after upload for quick
        classification without running the expensive SAM3 segmentation.

        Args:
            image_path: Path to the figure image
            ocr_text: OCR text for additional context
            run_id: Optional run identifier for tracking

        Returns:
            Dict containing:
                - figure_type: Classification result (flowchart, other, etc.)
                - confidence: Classification confidence score (0-1)
                - reasoning: Model's reasoning for classification
                - classification_duration_ms: Time taken for classification
                - model_config: Configuration used for classification
        """
        processor = self._get_processor()
        image_path = Path(image_path)

        classification_start = time.perf_counter()
        classification = processor.classify_figure(image_path, ocr_text=ocr_text)
        classification_duration = int((time.perf_counter() - classification_start) * 1000)

        return {
            "figure_type": classification.figure_type.value,
            "confidence": classification.confidence,
            "reasoning": classification.reasoning,
            "classification_duration_ms": classification_duration,
        }

    def describe_only(
        self,
        image_path: str | Path,
        ocr_text: str = "",
        *,
        run_id: str | None = None,
    ) -> dict[str, Any]:
        """Generate a description for non-flowchart images (fast path for OTHER type).

        This is designed for images classified as OTHER, where SAM3 segmentation
        and Mermaid extraction are not needed. It directly generates an LLM
        description of the image content.

        Args:
            image_path: Path to the figure image
            ocr_text: OCR text for additional context
            run_id: Optional run identifier for tracking

        Returns:
            Dict containing:
                - figure_type: Always "other"
                - description: LLM-generated description of the image
                - description_duration_ms: Time taken for description generation
        """
        from src.figure_processing import FigureType

        processor = self._get_processor()
        image_path = Path(image_path)

        description_start = time.perf_counter()

        # Process the figure with force_type=OTHER to skip SAM3 and get description
        result = processor.process_figure(
            image_path=image_path,
            ocr_text=ocr_text,
            shape_positions=None,
            text_positions=None,
            run_id=run_id,
            force_type=FigureType.OTHER,
        )

        description_duration = int((time.perf_counter() - description_start) * 1000)

        return {
            "figure_type": "other",
            "description": result.description,
            "processed_content": result.processed_content,
            "description_duration_ms": description_duration,
        }

    def detect_direction_only(
        self,
        image_path: str | Path,
        *,
        run_id: str | None = None,
    ) -> dict[str, Any]:
        """Detect flow direction for flowcharts (auto step after classification).

        This detects the primary flow direction (LR/TB/RL/BT) in a diagram.
        Should only be called for flowchart-type figures.

        Args:
            image_path: Path to the figure image
            run_id: Optional run identifier for tracking

        Returns:
            Dict containing:
                - direction: Detected direction (LR, TB, RL, BT)
                - direction_duration_ms: Time taken for detection
                - model_config: Configuration used for detection
        """
        image_path = Path(image_path)
        direction = "LR"  # Default fallback

        direction_start = time.perf_counter()
        try:
            from src.prompts.figure_direction_prompt import detect_direction

            direction_result = detect_direction(image_path)
            direction = direction_result.direction.value
            logger.debug(f"Detected flow direction: {direction}")
        except Exception as e:
            logger.warning(f"Direction detection failed, using default LR: {e}")

        direction_duration = int((time.perf_counter() - direction_start) * 1000)

        return {
            "direction": direction,
            "direction_duration_ms": direction_duration,
        }

    def segment_only(
        self,
        image_path: str | Path,
        ocr_text: str = "",
        *,
        run_id: str | None = None,
        text_positions: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        """Run classification + SAM3 segmentation without mermaid extraction.

        This is stage 1 of the two-stage pipeline, allowing visual inspection
        of shape detection before proceeding with mermaid generation.

        Args:
            image_path: Path to the figure image
            ocr_text: OCR text for additional context
            run_id: Optional run identifier for tracking
            text_positions: Text position data for SAM3 annotations

        Returns:
            Dict containing:
                - figure_type: Classification result
                - confidence: Classification confidence
                - direction: Detected flow direction (LR/TB/RL/BT)
                - shape_positions: SAM3 detected shapes
                - annotated_path: Path to annotated image (if available)
                - classification_duration_ms: Time for classification
                - sam3_duration_ms: Time for SAM3 segmentation
        """
        from src.figure_processing import FigureProcessor as PolicyFigureProcessor

        processor = self._get_processor()
        image_path = Path(image_path)

        # Step 1: Classification
        classification_start = time.perf_counter()
        classification = processor.classify_figure(image_path, ocr_text=ocr_text)
        classification_duration = int((time.perf_counter() - classification_start) * 1000)

        result: dict[str, Any] = {
            "figure_type": classification.figure_type.value,
            "confidence": classification.confidence,
            "reasoning": classification.reasoning,
            "classification_duration_ms": classification_duration,
            "direction": None,
            "shape_positions": None,
            "annotated_path": None,
            "sam3_duration_ms": None,
        }

        # Step 2: SAM3 segmentation (only for flowchart types)
        if classification.figure_type not in PolicyFigureProcessor.FLOWCHART_TYPES:
            logger.debug(f"Skipping SAM3 for non-flowchart type: {classification.figure_type}")
            return result

        # Detect flow direction
        direction = "LR"
        try:
            from src.prompts.figure_direction_prompt import detect_direction

            direction_result = detect_direction(image_path)
            direction = direction_result.direction.value
            logger.debug(f"Detected flow direction: {direction}")
        except Exception as e:
            logger.warning(f"Direction detection failed, using default LR: {e}")

        result["direction"] = direction

        # Run SAM3 segmentation using processor's segment_and_annotate (PaC Facade pattern)
        sam3_start = time.perf_counter()
        try:
            logger.debug(f"Calling segment_and_annotate with:")
            logger.debug(f"  image_path: {image_path}")
            logger.debug(f"  text_positions: {len(text_positions) if text_positions else 'None'}")
            logger.debug(f"  direction: {direction}")

            annotated_path, shape_positions, _ = processor.segment_and_annotate(
                image_path,
                text_positions=text_positions,
                direction=direction,
            )
            sam3_duration = int((time.perf_counter() - sam3_start) * 1000)
            result["sam3_duration_ms"] = sam3_duration

            logger.debug(f"SAM3 segment_and_annotate returned:")
            logger.debug(f"  annotated_path: {annotated_path}")
            logger.debug(f"  shape_positions count: {len(shape_positions) if shape_positions else 'None'}")
            if shape_positions:
                for i, sp in enumerate(shape_positions[:5]):  # Log first 5
                    logger.debug(f"  shape_positions[{i}]: id={sp.get('id')}, bbox={sp.get('bbox')}, color={sp.get('color')}")
                if len(shape_positions) > 5:
                    logger.debug(f"  ... and {len(shape_positions) - 5} more shapes")

            if annotated_path and shape_positions:
                result["annotated_path"] = str(annotated_path)
                result["shape_positions"] = shape_positions
                logger.info(f"SAM3 segmentation complete: {len(shape_positions)} shapes")
            else:
                logger.warning("SAM3 returned no shape positions")
        except Exception as e:
            sam3_duration = int((time.perf_counter() - sam3_start) * 1000)
            result["sam3_duration_ms"] = sam3_duration
            logger.warning(f"SAM3 segmentation failed: {e}")
            result["error"] = str(e)

        return result

    def segment_and_save(
        self,
        image_path: str | Path,
        output_dir: str | Path,
        element_id: str,
        ocr_text: str = "",
        *,
        run_id: str | None = None,
        text_positions: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        """Run SAM3 segmentation and save results.

        Creates:
            - {element_id}.sam3.json - Segmentation results
            - {element_id}.annotated.png - Annotated image (if SAM3 available)

        Args:
            image_path: Path to the original figure image
            output_dir: Directory to save results
            element_id: Unique identifier for the figure element
            ocr_text: OCR text from the figure
            run_id: Optional run identifier
            text_positions: Text position data for SAM3 annotations

        Returns:
            Segmentation results dict with added 'output_paths' key
        """
        output_dir = Path(output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)
        image_path = Path(image_path)

        result = self.segment_only(
            image_path, ocr_text, run_id=run_id, text_positions=text_positions
        )

        # Copy annotated image to output directory
        if result.get("annotated_path"):
            src_annotated = Path(result["annotated_path"])
            if src_annotated.exists():
                dst_annotated = output_dir / f"{element_id}.annotated.png"
                shutil.copy2(src_annotated, dst_annotated)
                result["annotated_path"] = str(dst_annotated)

        # Build SAM3 result JSON
        sam3_data = {
            "version": "1.0",
            "stage": "segmented",
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "element_id": element_id,
            "figure_type": result.get("figure_type"),
            "confidence": result.get("confidence"),
            "reasoning": result.get("reasoning"),
            "direction": result.get("direction"),
            "classification_duration_ms": result.get("classification_duration_ms"),
            "sam3_duration_ms": result.get("sam3_duration_ms"),
            "shape_positions": result.get("shape_positions"),
            "annotated_image": f"{element_id}.annotated.png" if result.get("annotated_path") else None,
        }

        logger.debug(f"segment_and_save saving SAM3 data:")
        logger.debug(f"  element_id: {element_id}")
        logger.debug(f"  figure_type: {sam3_data.get('figure_type')}")
        logger.debug(f"  shape_positions count: {len(sam3_data.get('shape_positions') or [])}")

        if result.get("error"):
            sam3_data["error"] = result["error"]

        # Save SAM3 results
        sam3_path = output_dir / f"{element_id}.sam3.json"
        with sam3_path.open("w", encoding="utf-8") as fh:
            json.dump(sam3_data, fh, ensure_ascii=False, indent=2)
            fh.write("\n")

        result["output_paths"] = {
            "sam3_json": str(sam3_path),
            "annotated": result.get("annotated_path"),
            "original": str(image_path),
        }

        logger.debug(f"Figure {element_id} segmented: type={result.get('figure_type')}")
        return result

    def extract_mermaid_from_sam3(
        self,
        image_path: str | Path,
        sam3_result: dict[str, Any],
        ocr_text: str = "",
        *,
        run_id: str | None = None,
        text_positions: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        """Run mermaid extraction using pre-computed SAM3 results.

        This is stage 2 of the two-stage pipeline. Requires SAM3 results
        from segment_only() or loaded from a .sam3.json file.

        Args:
            image_path: Path to the figure image (or annotated version)
            sam3_result: Pre-computed SAM3 segmentation results
            ocr_text: OCR text for additional context
            run_id: Optional run identifier
            text_positions: Text position data (optional, used if not in sam3_result)

        Returns:
            Full processing result with mermaid code
        """
        from src.figure_processing import FigureType

        processor = self._get_processor()
        image_path = Path(image_path)

        # Use annotated image if available
        annotated_path = sam3_result.get("annotated_path")
        if annotated_path and Path(annotated_path).exists():
            processing_image_path = Path(annotated_path)
        else:
            processing_image_path = image_path

        # Get shape positions from SAM3 result
        shape_positions = sam3_result.get("shape_positions")

        # Determine force_type from SAM3 result
        figure_type_str = sam3_result.get("figure_type", "other")
        try:
            force_type = FigureType(figure_type_str)
        except ValueError:
            force_type = FigureType.OTHER

        # Debug logging to diagnose Mermaid extraction issues
        logger.debug(f"Calling process_figure with:")
        logger.debug(f"  image_path: {processing_image_path}")
        logger.debug(f"  ocr_text length: {len(ocr_text)}")
        logger.debug(f"  shape_positions: {len(shape_positions) if shape_positions else 'None'}")
        logger.debug(f"  text_positions: {len(text_positions) if text_positions else 'None'}")
        logger.debug(f"  force_type: {force_type}")

        # Call processor with pre-computed shape positions
        result = processor.process_figure(
            image_path=processing_image_path,
            ocr_text=ocr_text,
            shape_positions=shape_positions,
            text_positions=text_positions,
            run_id=run_id,
            force_type=force_type,
        )

        # Debug logging for result inspection
        logger.debug(
            f"Raw result processed_content (first 500 chars): "
            f"{result.processed_content[:500] if result.processed_content else 'None'}"
        )
        logger.debug(f"Result intermediate_nodes: {result.intermediate_nodes}")

        return result.model_dump()

    def extract_mermaid_and_save(
        self,
        image_path: str | Path,
        output_dir: str | Path,
        element_id: str,
        ocr_text: str = "",
        *,
        run_id: str | None = None,
        text_positions: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        """Load SAM3 results and run mermaid extraction.

        Prerequisites: {element_id}.sam3.json must exist in output_dir.

        Creates:
            - {element_id}.json - Full processing results

        Args:
            image_path: Path to the original figure image
            output_dir: Directory containing SAM3 results and to save final results
            element_id: Unique identifier for the figure element
            ocr_text: OCR text from the figure
            run_id: Optional run identifier
            text_positions: Text position data for processing

        Returns:
            Full processing results with mermaid code

        Raises:
            FileNotFoundError: If SAM3 results don't exist
        """
        output_dir = Path(output_dir)
        image_path = Path(image_path)

        # Load SAM3 results
        sam3_path = output_dir / f"{element_id}.sam3.json"
        if not sam3_path.exists():
            raise FileNotFoundError(f"SAM3 results not found: {sam3_path}")

        with sam3_path.open("r", encoding="utf-8") as fh:
            sam3_result = json.load(fh)

        logger.debug(f"extract_mermaid_and_save loaded SAM3 data from {sam3_path}:")
        logger.debug(f"  figure_type: {sam3_result.get('figure_type')}")
        logger.debug(f"  direction: {sam3_result.get('direction')}")
        logger.debug(f"  shape_positions count: {len(sam3_result.get('shape_positions') or [])}")
        if sam3_result.get("shape_positions"):
            for i, sp in enumerate(sam3_result["shape_positions"][:5]):
                logger.debug(f"  shape_positions[{i}]: id={sp.get('id')}, bbox={sp.get('bbox')}, color={sp.get('color')}")

        # Resolve annotated image path
        annotated_image = sam3_result.get("annotated_image")
        if annotated_image:
            sam3_result["annotated_path"] = str(output_dir / annotated_image)

        result = self.extract_mermaid_from_sam3(
            image_path, sam3_result, ocr_text, run_id=run_id, text_positions=text_positions
        )

        # Save full JSON results
        json_path = output_dir / f"{element_id}.json"
        with json_path.open("w", encoding="utf-8") as fh:
            json.dump(result, fh, ensure_ascii=False, indent=2)
            fh.write("\n")

        # Update SAM3 file to mark extraction complete
        sam3_result["stage"] = "complete"
        sam3_result["extraction_timestamp"] = datetime.now(timezone.utc).isoformat()
        with sam3_path.open("w", encoding="utf-8") as fh:
            json.dump(sam3_result, fh, ensure_ascii=False, indent=2)
            fh.write("\n")

        result["output_paths"] = {
            "json": str(json_path),
            "sam3_json": str(sam3_path),
            "original": str(image_path),
        }

        logger.debug(f"Figure {element_id} mermaid extracted: type={result.get('figure_type')}")
        return result

    def process_and_save(
        self,
        image_path: str | Path,
        output_dir: str | Path,
        element_id: str,
        ocr_text: str = "",
        *,
        run_id: str | None = None,
        text_positions: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        """Process a figure and save results to output directory.

        Creates:
            - {element_id}.json - Full processing results
            - {element_id}.annotated.png - Annotated image (if SAM3 available)

        Args:
            image_path: Path to the original figure image
            output_dir: Directory to save results
            element_id: Unique identifier for the figure element
            ocr_text: OCR text from the figure
            run_id: Optional run identifier
            text_positions: Text position data for SAM3 annotations

        Returns:
            Processing results dict with added 'output_paths' key
        """
        output_dir = Path(output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)

        result = self.process_figure(
            image_path, ocr_text, run_id=run_id, text_positions=text_positions
        )

        # Save JSON results
        json_path = output_dir / f"{element_id}.json"
        with json_path.open("w", encoding="utf-8") as fh:
            json.dump(result, fh, ensure_ascii=False, indent=2)
            fh.write("\n")

        result["output_paths"] = {
            "json": str(json_path),
            "original": str(image_path),
        }

        logger.debug(f"Figure {element_id} processed: type={result.get('figure_type')}")
        return result

    def process_elements_batch(
        self,
        elements: list[dict[str, Any]],
        figures_dir: str | Path,
        *,
        run_id: str | None = None,
    ) -> list[dict[str, Any]]:
        """Process all figure elements from an extraction run.

        Args:
            elements: List of element dicts from Azure DI extraction
            figures_dir: Directory containing figure images
            run_id: Optional run identifier

        Returns:
            Updated elements list with figure_processing added to figure elements
        """
        figures_dir = Path(figures_dir)
        processed = []

        for el in elements:
            if el.get("type") != "figure":
                processed.append(el)
                continue

            element_id = el.get("id", "")
            image_filename = el.get("figure_image_filename")

            if not image_filename:
                logger.warning(f"Figure {element_id} has no image filename, skipping")
                processed.append(el)
                continue

            image_path = figures_dir / image_filename
            if not image_path.exists():
                logger.warning(f"Figure image not found: {image_path}")
                processed.append(el)
                continue

            try:
                ocr_text = el.get("content", "") or el.get("text", "")
                result = self.process_and_save(
                    image_path=image_path,
                    output_dir=figures_dir,
                    element_id=element_id,
                    ocr_text=ocr_text,
                    run_id=run_id,
                )
                el["figure_processing"] = {
                    "figure_type": result.get("figure_type"),
                    "confidence": result.get("confidence"),
                    "processed_content": result.get("processed_content"),
                    "description": result.get("description"),
                    "step1_duration_ms": result.get("step1_duration_ms"),
                    "step2_duration_ms": result.get("step2_duration_ms"),
                }
                processed.append(el)
            except Exception as e:
                logger.error(f"Failed to process figure {element_id}: {e}")
                el["figure_processing"] = {"error": str(e)}
                processed.append(el)

        return processed


# Module-level singleton for convenience
_processor: FigureProcessorWrapper | None = None


def get_processor() -> FigureProcessorWrapper:
    """Get or create the module-level FigureProcessorWrapper instance."""
    global _processor
    if _processor is None:
        _processor = FigureProcessorWrapper()
    return _processor
