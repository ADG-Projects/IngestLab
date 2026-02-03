from .admin import router as admin_router
from .chunker import router as chunker_router
from .chunks import router as chunks_router
from .elements import clear_index_cache, router as elements_router
from .extractions import router as extractions_router
from .feedback import router as feedback_router
from .images import router as images_router
from .pdfs import router as pdfs_router
from .reviews import router as reviews_router

__all__ = [
    "admin_router",
    "chunker_router",
    "chunks_router",
    "elements_router",
    "extractions_router",
    "feedback_router",
    "images_router",
    "pdfs_router",
    "reviews_router",
    "clear_index_cache",
]
