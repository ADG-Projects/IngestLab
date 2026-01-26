/**
 * Mermaid parsing and Cytoscape diagram visualization
 * Extracted from app-images.js for modularity
 */

let currentCyInstance = null;
let cytoscapeOverlay = null;

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
      'text-max-width': '110px',
      'font-size': '12px',
      'font-family': 'Segoe UI, Tahoma, sans-serif',
      'text-valign': 'center',
      'text-halign': 'center',
      'width': 120,
      'height': 40,
      'padding': '8px',
      'shape': 'round-rectangle',
      'color': '#1a1a1a'
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
      'width': 100,
      'height': 70,
      'text-max-width': '70px',
      'font-size': '8px'
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
      'width': 70,
      'height': 45,
      'text-max-width': '60px',
      'font-size': '8px',
      'font-weight': 'bold'
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
    selector: 'edge',
    style: {
      'width': 2.5,
      'line-color': '#72808a',
      'target-arrow-color': '#72808a',
      'target-arrow-shape': 'triangle',
      'curve-style': 'bezier',
      'label': 'data(label)',
      'font-size': '10px',
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
 */
function initCytoscapeDiagram(containerId, mermaidCode, shapePositions) {
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

  if (shapePositions && shapePositions.length > 0) {
    for (const node of nodes) {
      const shape = shapePositions.find(s => s.id === node.data.id);
      if (shape && shape.bbox && shape.bbox.length === 4) {
        const [x1, y1, x2, y2] = shape.bbox;
        // Scale normalized bbox (0-1) to container dimensions
        node.position = {
          x: ((x1 + x2) / 2) * containerWidth,
          y: ((y1 + y2) / 2) * containerHeight
        };
        if (shape.color) {
          node.data.shapeColor = sam3ColorToHex(shape.color);
        }
        matchedCount++;
        console.log(`Node ${node.data.id} matched shape:`, { bbox: shape.bbox, color: shape.color, position: node.position });
      } else {
        console.log(`Node ${node.data.id} NOT matched, available shapes:`, shapePositions.map(s => s.id));
      }
    }
  }

  console.log(`SAM3 position matching: ${matchedCount}/${nodes.length} nodes matched`);
  const usePresetLayout = matchedCount >= nodes.length * 0.8;

  // Destroy existing instance
  if (currentCyInstance) {
    currentCyInstance.destroy();
  }

  currentCyInstance = cytoscape({
    container,
    elements: { nodes, edges },
    style: CYTOSCAPE_STYLE,
    layout: usePresetLayout ? {
      name: 'preset',
      fit: true,
      padding: 30
    } : {
      name: 'cose',
      idealEdgeLength: 180,
      nodeOverlap: 8,
      refresh: 20,
      fit: true,
      padding: 50,
      randomize: false,
      componentSpacing: 150,
      nodeRepulsion: 20000,
      edgeElasticity: 100,
      nestingFactor: 5,
      gravity: 50,
      numIter: 1200,
      initialTemp: 220,
      coolingFactor: 0.92,
      minTemp: 0.8
    }
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
  const container = document.querySelector('.cytoscape-container');
  if (!container) return;

  // Toggle maximized state
  if (container.classList.contains('maximized')) {
    cytoscapeMinimize();
  } else {
    cytoscapeMaximize();
  }
}

function cytoscapeMaximize() {
  const container = document.querySelector('.cytoscape-container');
  if (!container) return;

  // Create overlay
  if (!cytoscapeOverlay) {
    cytoscapeOverlay = document.createElement('div');
    cytoscapeOverlay.className = 'cytoscape-overlay';
    cytoscapeOverlay.addEventListener('click', cytoscapeMinimize);
    document.body.appendChild(cytoscapeOverlay);
  }
  cytoscapeOverlay.style.display = 'block';

  // Maximize container
  container.classList.add('maximized');

  // Resize cytoscape instance after animation
  setTimeout(() => {
    if (currentCyInstance) {
      currentCyInstance.resize();
      currentCyInstance.fit();
    }
  }, 100);

  // Handle Escape key
  document.addEventListener('keydown', cytoscapeEscapeHandler);
}

function cytoscapeMinimize() {
  const container = document.querySelector('.cytoscape-container');
  if (!container) return;

  // Hide overlay
  if (cytoscapeOverlay) {
    cytoscapeOverlay.style.display = 'none';
  }

  // Remove maximized state
  container.classList.remove('maximized');

  // Resize cytoscape instance after animation
  setTimeout(() => {
    if (currentCyInstance) {
      currentCyInstance.resize();
      currentCyInstance.fit();
    }
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
