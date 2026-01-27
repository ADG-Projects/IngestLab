/**
 * Image lightbox modal with zoom/pan functionality
 * Extracted from app-images.js for modularity
 */

let lightboxZoom = 1;
let lightboxPanX = 0;
let lightboxPanY = 0;
let lightboxDragging = false;
let lightboxDragStart = { x: 0, y: 0 };

/**
 * Open an image in the lightbox modal.
 */
function openImageLightbox(src, alt) {
  // Create lightbox if it doesn't exist
  let lightbox = document.getElementById('imageLightbox');

  if (!lightbox) {
    lightbox = document.createElement('div');
    lightbox.id = 'imageLightbox';
    lightbox.className = 'image-lightbox';
    lightbox.innerHTML = `
      <div class="lightbox-overlay" onclick="closeImageLightbox()"></div>
      <div class="lightbox-content">
        <div class="lightbox-header">
          <span class="lightbox-title"></span>
          <div class="lightbox-controls">
            <button class="btn btn-icon" onclick="lightboxZoomIn()" title="Zoom in">+</button>
            <button class="btn btn-icon" onclick="lightboxZoomOut()" title="Zoom out">−</button>
            <button class="btn btn-icon" onclick="lightboxResetZoom()" title="Reset zoom">⟲</button>
            <button class="btn btn-icon lightbox-close" onclick="closeImageLightbox()" title="Close">×</button>
          </div>
        </div>
        <div class="lightbox-image-container">
          <img class="lightbox-image" draggable="false" />
        </div>
        <div class="lightbox-footer">
          <span class="lightbox-zoom-level">100%</span>
        </div>
      </div>
    `;
    document.body.appendChild(lightbox);

    // Add wheel zoom
    const container = lightbox.querySelector('.lightbox-image-container');
    container.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (e.deltaY < 0) {
        lightboxZoomIn();
      } else {
        lightboxZoomOut();
      }
    });

    // Add pan support
    const img = lightbox.querySelector('.lightbox-image');
    container.addEventListener('mousedown', (e) => {
      if (lightboxZoom > 1) {
        lightboxDragging = true;
        lightboxDragStart = { x: e.clientX - lightboxPanX, y: e.clientY - lightboxPanY };
        container.style.cursor = 'grabbing';
      }
    });
    document.addEventListener('mousemove', (e) => {
      if (lightboxDragging) {
        lightboxPanX = e.clientX - lightboxDragStart.x;
        lightboxPanY = e.clientY - lightboxDragStart.y;
        updateLightboxTransform();
      }
    });
    document.addEventListener('mouseup', () => {
      lightboxDragging = false;
      const container = document.querySelector('.lightbox-image-container');
      if (container) container.style.cursor = lightboxZoom > 1 ? 'grab' : 'default';
    });

    // Close on escape
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && lightbox.classList.contains('active')) {
        closeImageLightbox();
      }
    });
  }

  // Reset zoom/pan
  lightboxZoom = 1;
  lightboxPanX = 0;
  lightboxPanY = 0;

  // Set image
  const img = lightbox.querySelector('.lightbox-image');
  img.src = src;
  img.alt = alt || 'Image preview';
  lightbox.querySelector('.lightbox-title').textContent = alt || 'Image Preview';
  updateLightboxTransform();

  // Show lightbox
  lightbox.classList.add('active');
  document.body.style.overflow = 'hidden';
}

/**
 * Close the image lightbox.
 */
function closeImageLightbox() {
  const lightbox = document.getElementById('imageLightbox');
  if (lightbox) {
    lightbox.classList.remove('active');
    document.body.style.overflow = '';
  }
}

/**
 * Zoom in the lightbox image.
 */
function lightboxZoomIn() {
  lightboxZoom = Math.min(lightboxZoom * 1.25, 5);
  updateLightboxTransform();
}

/**
 * Zoom out the lightbox image.
 */
function lightboxZoomOut() {
  lightboxZoom = Math.max(lightboxZoom / 1.25, 0.5);
  if (lightboxZoom <= 1) {
    lightboxPanX = 0;
    lightboxPanY = 0;
  }
  updateLightboxTransform();
}

/**
 * Reset lightbox zoom to 100%.
 */
function lightboxResetZoom() {
  lightboxZoom = 1;
  lightboxPanX = 0;
  lightboxPanY = 0;
  updateLightboxTransform();
}

/**
 * Update the lightbox image transform.
 */
function updateLightboxTransform() {
  const lightbox = document.getElementById('imageLightbox');
  if (!lightbox) return;

  const img = lightbox.querySelector('.lightbox-image');
  const container = lightbox.querySelector('.lightbox-image-container');
  const zoomLabel = lightbox.querySelector('.lightbox-zoom-level');

  img.style.transform = `translate(${lightboxPanX}px, ${lightboxPanY}px) scale(${lightboxZoom})`;
  container.style.cursor = lightboxZoom > 1 ? 'grab' : 'default';
  zoomLabel.textContent = `${Math.round(lightboxZoom * 100)}%`;
}

// Window exports
window.openImageLightbox = openImageLightbox;
window.closeImageLightbox = closeImageLightbox;
window.lightboxZoomIn = lightboxZoomIn;
window.lightboxZoomOut = lightboxZoomOut;
window.lightboxResetZoom = lightboxResetZoom;
