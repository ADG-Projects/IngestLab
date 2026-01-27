/**
 * Mermaid parsing and Cytoscape diagram visualization
 * Extracted from app-images.js for modularity
 */

let currentCyInstance = null;
let cytoscapeOverlay = null;
let originalParent = null;  // Store original parent for minimize
let elkRegistered = false;

/**
 * Register ELK layout extension with Cytoscape.
 */
function registerElk() {
  if (elkRegistered) return;
  if (typeof cytoscape !== 'undefined' && typeof cytoscapeElk !== 'undefined' && typeof ELK !== 'undefined') {
    cytoscape.use(cytoscapeElk);
    elkRegistered = true;
    console.log('ELK layout registered with Cytoscape');
  }
}

/**
 * Convert SAM3 color names to hex codes.
 */
function sam3ColorToHex(colorName) {
  const colorMap = {
    'red': '#e74c3c',
    'blue': '#3498db',
    'green': '#2ecc71',
    'orange': '#e67e22',
    'purple': '#9b59b6',
    'cyan': '#1abc9c',
    'pink': '#fd79a8',
    'yellow-green': '#badc58',
    'brown': '#795548',
    'slate-blue': '#6c5ce7',
    'teal': '#00b894',
    'mauve': '#a29bfe',
    'olive': '#6c7a89',
    'tan': '#dfe4ea',
    'plum': '#c56cf0',
    'forest': '#006266',
    'crimson': '#d63031',
    'steel-blue': '#74b9ff',
    'lime': '#7bed9f',
    'sienna': '#a0522d',
    'lavender': '#dfe6e9',
    'dark-cyan': '#006d77',
    'rose': '#ff7979',
    'moss': '#6a994e'
  };
  return colorMap[colorName] || '#4fc3f7';
}

/**
 * Parse Mermaid flowchart code to Cytoscape elements format.
 */
function parseMermaidToCytoscape(mermaidCode) {
  const nodes = [];
  const edges = [];
  const nodeMap = {};

  function cleanLabel(label) {
    if (!label) return '';
    return label
      .replace(/#quot;/g, '"')
      .replace(/#40;/g, '(')
      .replace(/#41;/g, ')')
      .replace(/#39;/g, "'")
      .replace(/#amp;/g, '&')
      .replace(/^["']+|["']+$/g, '')  // Strip surrounding quotes (handles "" empty labels)
      .trim();
  }

  function extractNodeInfo(str) {
    // A((label)) = terminal (start/end)
    let match = str.match(/^([A-Za-z0-9_]+)\s*\(\(([^)]+)\)\)\s*$/);
    if (match) return { id: match[1], label: cleanLabel(match[2]), type: 'terminal' };

    // A[[label]] = subprocess
    match = str.match(/^([A-Za-z0-9_]+)\s*\[\[([^\]]+)\]\]\s*$/);
    if (match) return { id: match[1], label: cleanLabel(match[2]), type: 'subprocess' };

    // A{label} = decision (diamond)
    match = str.match(/^([A-Za-z0-9_]+)\s*\{([^}]+)\}\s*$/);
    if (match) return { id: match[1], label: cleanLabel(match[2]), type: 'decision' };

    // A[label] = process (rectangle)
    match = str.match(/^([A-Za-z0-9_]+)\s*\[([^\]]+)\]\s*$/);
    if (match) return { id: match[1], label: cleanLabel(match[2]), type: 'process' };

    // A(label) = rounded process
    match = str.match(/^([A-Za-z0-9_]+)\s*\(([^)]+)\)\s*$/);
    if (match) return { id: match[1], label: cleanLabel(match[2]), type: 'process' };

    // Just an ID
    match = str.match(/^([A-Za-z0-9_]+)\s*$/);
    if (match) return { id: match[1], label: null, type: 'process' };

    return null;
  }

  const nodeTypes = {};
  const lines = mermaidCode.split('\n');

  // First pass: extract all node definitions
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('flowchart') || trimmed.startsWith('%%')) continue;

    if (trimmed.startsWith('subgraph') || trimmed === 'end') continue;

    // Split line by arrows to find all node definitions
    const parts = trimmed.split(/\s*(?:-->|---)\s*(?:\|[^|]*\|)?\s*/);
    for (const part of parts) {
      const info = extractNodeInfo(part.trim());
      // Allow nodes even if label is empty - use ID as fallback
      if (info && !nodeMap[info.id]) {
        nodeMap[info.id] = info.label || info.id;  // Fallback to ID when label is empty
        nodeTypes[info.id] = info.type;
      }
    }
  }

  // Second pass: create edges
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('flowchart') || trimmed.startsWith('%%') ||
        trimmed.startsWith('subgraph') || trimmed === 'end') continue;

    const edgePattern = /([A-Za-z0-9_]+)(?:\s*[\[\(\{]+[^\]\)\}]*[\]\)\}]+)?\s*(-->|---)\s*(?:\|([^|]*)\|)?\s*([A-Za-z0-9_]+)/g;
    let match;
    while ((match = edgePattern.exec(trimmed)) !== null) {
      const [, source, , edgeLabel, target] = match;
      edges.push({ data: { source, target, label: edgeLabel || '' } });
    }
  }

  // Create node elements from the map with type info
  for (const [id, label] of Object.entries(nodeMap)) {
    const nodeType = nodeTypes[id] || 'process';
    nodes.push({ data: { id, label: label || id, type: nodeType } });
  }

  // Add any nodes that appear in edges but weren't defined
  const nodeIds = new Set(nodes.map(n => n.data.id));
  for (const edge of edges) {
    if (!nodeIds.has(edge.data.source)) {
      nodes.push({ data: { id: edge.data.source, label: edge.data.source, type: 'process' } });
      nodeIds.add(edge.data.source);
    }
    if (!nodeIds.has(edge.data.target)) {
      nodes.push({ data: { id: edge.data.target, label: edge.data.target, type: 'process' } });
      nodeIds.add(edge.data.target);
    }
  }

  return { nodes, edges };
}

/**
 * Cytoscape style configuration.
 */
const CYTOSCAPE_STYLE = [
  {
    selector: 'node',
    style: {
      'background-color': '#4fc3f7',
      'background-opacity': 0.85,
      'border-color': '#0288d1',
      'border-width': 2,
      'label': 'data(label)',
      'text-wrap': 'wrap',
      'text-max-width': '70px',
      'font-size': '10px',
      'font-family': 'Segoe UI, Tahoma, sans-serif',
      'text-valign': 'center',
      'text-halign': 'center',
      'width': 80,
      'height': 32,
      'padding': '4px',
      'shape': 'round-rectangle',
      'color': '#1a1a1a'
    }
  },
  // Dynamic sizing for nodes with SAM3 bbox data
  {
    selector: 'node[nodeWidth]',
    style: {
      'width': 'data(nodeWidth)',
      'height': 'data(nodeHeight)',
      'text-max-width': function(ele) {
        return Math.max(ele.data('nodeWidth') - 10, 40) + 'px';
      },
      'font-size': function(ele) {
        // Scale font based on node size
        const size = Math.min(ele.data('nodeWidth'), ele.data('nodeHeight'));
        return Math.max(Math.min(size / 6, 14), 8) + 'px';
      }
    }
  },
  {
    selector: 'node[type = "decision"]',
    style: {
      'background-color': '#fff59d',
      'background-opacity': 0.9,
      'border-color': '#f9a825',
      'border-width': 3,
      'shape': 'diamond',
      'width': 70,
      'height': 50,
      'text-max-width': '55px',
      'font-size': '8px'
    }
  },
  {
    selector: 'node[type = "decision"][nodeWidth]',
    style: {
      'width': 'data(nodeWidth)',
      'height': 'data(nodeHeight)'
    }
  },
  {
    selector: 'node[type = "terminal"]',
    style: {
      'background-color': '#a5d6a7',
      'background-opacity': 0.9,
      'border-color': '#388e3c',
      'border-width': 3,
      'shape': 'ellipse',
      'width': 55,
      'height': 35,
      'text-max-width': '45px',
      'font-size': '8px',
      'font-weight': 'bold'
    }
  },
  {
    selector: 'node[type = "terminal"][nodeWidth]',
    style: {
      'width': 'data(nodeWidth)',
      'height': 'data(nodeHeight)'
    }
  },
  {
    selector: 'node[type = "subprocess"]',
    style: {
      'background-color': '#ce93d8',
      'background-opacity': 0.9,
      'border-color': '#7b1fa2',
      'border-width': 4,
      'shape': 'round-rectangle'
    }
  },
  {
    selector: 'node[type = "subprocess"][nodeWidth]',
    style: {
      'width': 'data(nodeWidth)',
      'height': 'data(nodeHeight)'
    }
  },
  {
    selector: 'edge',
    style: {
      'width': 2,
      'line-color': '#72808a',
      'target-arrow-color': '#72808a',
      'target-arrow-shape': 'triangle',
      'curve-style': 'bezier',
      'label': 'data(label)',
      'font-size': '9px',
      'text-background-color': '#fff',
      'text-background-opacity': 1,
      'text-background-padding': '2px'
    }
  },
  {
    selector: 'node:selected',
    style: {
      'background-color': '#ff9800',
      'border-color': '#e65100'
    }
  },
  {
    selector: 'node[shapeColor]',
    style: {
      'background-color': 'data(shapeColor)',
      'border-color': 'data(shapeColor)',
      'border-width': 3,
      'color': '#ffffff',
      'text-outline-color': '#000000',
      'text-outline-width': 1
    }
  },
  {
    selector: 'node[type = "decision"][shapeColor]',
    style: {
      'background-color': 'data(shapeColor)',
      'border-color': 'data(shapeColor)',
      'color': '#ffffff',
      'text-outline-color': '#000000',
      'text-outline-width': 1
    }
  },
  {
    selector: 'node[type = "terminal"][shapeColor]',
    style: {
      'background-color': 'data(shapeColor)',
      'border-color': 'data(shapeColor)',
      'color': '#ffffff',
      'text-outline-color': '#000000',
      'text-outline-width': 1
    }
  },
  {
    selector: 'node[type = "subprocess"][shapeColor]',
    style: {
      'background-color': 'data(shapeColor)',
      'border-color': 'data(shapeColor)',
      'color': '#ffffff',
      'text-outline-color': '#000000',
      'text-outline-width': 1
    }
  }
];

/**
 * Initialize Cytoscape diagram from Mermaid code with SAM3 positions.
 * @param {string} containerId - DOM element ID for the container
 * @param {string} mermaidCode - Mermaid flowchart code
 * @param {Array} shapePositions - SAM3 shape position data
 * @param {Object} imageDimensions - Original image dimensions {width, height}
 */
function initCytoscapeDiagram(containerId, mermaidCode, shapePositions, imageDimensions) {
  const container = document.getElementById(containerId);
  if (!container || !mermaidCode) return;

  // Check if cytoscape is loaded
  if (typeof cytoscape === 'undefined') {
    console.warn('Cytoscape not loaded yet');
    container.innerHTML = '<span class="no-data">Loading Cytoscape...</span>';
    return;
  }

  const { nodes, edges } = parseMermaidToCytoscape(mermaidCode);
  if (nodes.length === 0) {
    container.innerHTML = '<span class="no-data">Could not parse Mermaid diagram</span>';
    return;
  }

  // Get container dimensions for proper scaling
  // SAM3 bbox coordinates are normalized (0-1 range)
  const containerWidth = container.clientWidth || 400;
  const containerHeight = container.clientHeight || 300;
  let matchedCount = 0;

  // Debug logging
  console.log('initCytoscapeDiagram:', {
    containerId,
    containerWidth,
    containerHeight,
    nodeCount: nodes.length,
    shapePositionsCount: shapePositions?.length || 0,
    shapePositions: shapePositions
  });

  // Use actual image dimensions if available, otherwise fall back to inferred aspect ratio
  // SAM3 bbox coordinates are normalized (0-1) based on original image dimensions
  let scaleX, scaleY;

  if (imageDimensions && imageDimensions.width && imageDimensions.height) {
    // Use actual image dimensions - this preserves exact proportions
    scaleX = imageDimensions.width;
    scaleY = imageDimensions.height;
    console.log('Using actual image dimensions:', { width: scaleX, height: scaleY });
  } else if (shapePositions && shapePositions.length > 0) {
    // Fall back to inferring aspect ratio from shape spread
    const BASE_SCALE = 1000;
    let minX = 1, maxX = 0, minY = 1, maxY = 0;
    for (const shape of shapePositions) {
      if (shape.bbox && shape.bbox.length === 4) {
        const [x1, y1, x2, y2] = shape.bbox;
        minX = Math.min(minX, x1);
        maxX = Math.max(maxX, x2);
        minY = Math.min(minY, y1);
        maxY = Math.max(maxY, y2);
      }
    }
    const spreadX = maxX - minX || 1;
    const spreadY = maxY - minY || 1;
    const aspectRatio = spreadX / spreadY;

    if (aspectRatio > 1) {
      scaleX = BASE_SCALE;
      scaleY = BASE_SCALE / aspectRatio;
    } else {
      scaleX = BASE_SCALE * aspectRatio;
      scaleY = BASE_SCALE;
    }
    console.log('Inferred aspect ratio:', { spreadX, spreadY, aspectRatio, scaleX, scaleY });
  } else {
    // Default to square
    scaleX = 1000;
    scaleY = 1000;
  }

  if (shapePositions && shapePositions.length > 0) {

    for (const node of nodes) {
      const shape = shapePositions.find(s => s.id === node.data.id);
      if (shape && shape.bbox && shape.bbox.length === 4) {
        const [x1, y1, x2, y2] = shape.bbox;
        // Scale normalized bbox preserving aspect ratio
        node.position = {
          x: ((x1 + x2) / 2) * scaleX,
          y: ((y1 + y2) / 2) * scaleY
        };
        // Calculate node dimensions from bbox (also scaled)
        const bboxWidth = (x2 - x1) * scaleX;
        const bboxHeight = (y2 - y1) * scaleY;
        // Store dimensions for per-node sizing (with minimum sizes)
        node.data.nodeWidth = Math.max(bboxWidth * 0.9, 50);
        node.data.nodeHeight = Math.max(bboxHeight * 0.9, 24);
        if (shape.color) {
          node.data.shapeColor = sam3ColorToHex(shape.color);
        }
        matchedCount++;
        console.log(`Node ${node.data.id} matched shape:`, { bbox: shape.bbox, color: shape.color, position: node.position, size: { w: node.data.nodeWidth, h: node.data.nodeHeight } });
      } else {
        console.log(`Node ${node.data.id} NOT matched, available shapes:`, shapePositions.map(s => s.id));
      }
    }
  }

  console.log(`SAM3 position matching: ${matchedCount}/${nodes.length} nodes matched`);
  const usePresetLayout = matchedCount >= nodes.length * 0.8;

  // Register ELK extension
  registerElk();

  // Destroy existing instance
  if (currentCyInstance) {
    currentCyInstance.destroy();
  }

  // Determine layout - use preset if SAM3 positions available, otherwise ELK (or COSE fallback)
  let layoutConfig;
  if (usePresetLayout) {
    layoutConfig = {
      name: 'preset',
      fit: true,
      padding: 40
    };
  } else if (elkRegistered) {
    // Use ELK layered layout for proper hierarchical diagrams
    layoutConfig = {
      name: 'elk',
      fit: true,
      padding: 50,
      elk: {
        algorithm: 'layered',
        'elk.direction': 'DOWN',
        'elk.spacing.nodeNode': 50,
        'elk.layered.spacing.nodeNodeBetweenLayers': 80,
        'elk.edgeRouting': 'ORTHOGONAL',
        'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP'
      }
    };
  } else {
    // Fallback to COSE if ELK not loaded
    layoutConfig = {
      name: 'cose',
      idealEdgeLength: 220,
      nodeOverlap: 20,
      refresh: 20,
      fit: true,
      padding: 60,
      randomize: false,
      componentSpacing: 200,
      nodeRepulsion: 40000,
      edgeElasticity: 100,
      nestingFactor: 5,
      gravity: 50,
      numIter: 1200,
      initialTemp: 220,
      coolingFactor: 0.92,
      minTemp: 0.8
    };
  }

  currentCyInstance = cytoscape({
    container,
    elements: { nodes, edges },
    style: CYTOSCAPE_STYLE,
    pixelRatio: 'auto',
    layout: layoutConfig
  });

  currentCyInstance.userPanningEnabled(true);
  currentCyInstance.userZoomingEnabled(true);
  currentCyInstance.fit();
}

/**
 * Cytoscape zoom/pan controls.
 */
function cytoscapeZoomIn() {
  if (currentCyInstance) currentCyInstance.zoom(currentCyInstance.zoom() * 1.2);
}

function cytoscapeZoomOut() {
  if (currentCyInstance) currentCyInstance.zoom(currentCyInstance.zoom() / 1.2);
}

function cytoscapeReset() {
  if (currentCyInstance) currentCyInstance.fit();
}

function cytoscapeFullscreen() {
  // Use the current Cytoscape instance's container
  if (!currentCyInstance) return;
  const container = currentCyInstance.container();
  if (!container) return;

  // Toggle maximized state
  if (container.classList.contains('maximized')) {
    cytoscapeMinimize();
  } else {
    cytoscapeMaximize();
  }
}

function cytoscapeMaximize() {
  // Use the current Cytoscape instance's container
  if (!currentCyInstance) return;
  const container = currentCyInstance.container();
  if (!container) return;

  // Create overlay
  if (!cytoscapeOverlay) {
    cytoscapeOverlay = document.createElement('div');
    cytoscapeOverlay.className = 'cytoscape-overlay';
    cytoscapeOverlay.addEventListener('click', cytoscapeMinimize);
    document.body.appendChild(cytoscapeOverlay);
  }
  cytoscapeOverlay.style.display = 'block';

  // Store original parent and move container to body to escape stacking context
  originalParent = container.parentNode;
  document.body.appendChild(container);

  // Maximize container - CSS handles the sizing
  container.classList.add('maximized');

  // Wait for CSS to apply, then recreate instance with new dimensions
  setTimeout(() => {
    if (!currentCyInstance) return;

    // Force layout recalculation
    container.offsetHeight;

    // Destroy and recreate to force proper canvas sizing
    // (Cytoscape's resize() doesn't properly update canvas dimensions)
    const elements = currentCyInstance.elements().jsons();
    currentCyInstance.destroy();

    currentCyInstance = cytoscape({
      container,
      elements,
      style: CYTOSCAPE_STYLE,
      layout: { name: 'preset' },
      pixelRatio: 'auto'
    });

    // Fit to show all elements with padding
    currentCyInstance.fit(undefined, 50);
  }, 200);

  // Handle Escape key
  document.addEventListener('keydown', cytoscapeEscapeHandler);
}

function cytoscapeMinimize() {
  // Use the current Cytoscape instance's container
  if (!currentCyInstance) return;
  const container = currentCyInstance.container();
  if (!container) return;

  // Hide overlay
  if (cytoscapeOverlay) {
    cytoscapeOverlay.style.display = 'none';
  }

  // Remove maximized state
  container.classList.remove('maximized');

  // Move container back to original parent
  if (originalParent) {
    originalParent.appendChild(container);
    originalParent = null;
  }

  // Recreate Cytoscape instance with new container size
  setTimeout(() => {
    if (!currentCyInstance) return;

    const elements = currentCyInstance.elements().jsons();
    currentCyInstance.destroy();

    currentCyInstance = cytoscape({
      container,
      elements,
      style: CYTOSCAPE_STYLE,
      layout: { name: 'preset' },
      pixelRatio: 'auto'
    });

    currentCyInstance.fit(undefined, 30);
  }, 100);

  // Remove Escape key handler
  document.removeEventListener('keydown', cytoscapeEscapeHandler);
}

function cytoscapeEscapeHandler(e) {
  if (e.key === 'Escape') {
    cytoscapeMinimize();
  }
}

// Window exports
window.sam3ColorToHex = sam3ColorToHex;
window.parseMermaidToCytoscape = parseMermaidToCytoscape;
window.initCytoscapeDiagram = initCytoscapeDiagram;
window.cytoscapeZoomIn = cytoscapeZoomIn;
window.cytoscapeZoomOut = cytoscapeZoomOut;
window.cytoscapeReset = cytoscapeReset;
window.cytoscapeFullscreen = cytoscapeFullscreen;
window.cytoscapeMaximize = cytoscapeMaximize;
window.cytoscapeMinimize = cytoscapeMinimize;
