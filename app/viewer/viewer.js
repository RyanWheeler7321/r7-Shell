const stage = document.getElementById('stage');
const picture = document.getElementById('picture');
const nameBadge = document.getElementById('nameBadge');
const zoomBadge = document.getElementById('zoomBadge');
const errorLine = document.getElementById('errorLine');

const params = new URLSearchParams(location.search);
const MIN_ZOOM = 0.05;
const MAX_ZOOM = 40;
const ANIMATION_MS = 120;
const BADGE_MS = 900;

// view = what is drawn; target = where the animation is heading
const view = { scale: 1, x: 0, y: 0 };
const target = { scale: 1, x: 0, y: 0 };
let fitMode = true;
let loaded = false;
let animating = false;
let animationStart = 0;
let animationFrom = null;
let zoomBadgeTimer = 0;
let nameBadgeTimer = 0;

function clampZoom(value) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
}

function fitScale() {
  const scale = Math.min(stage.clientWidth / picture.naturalWidth, stage.clientHeight / picture.naturalHeight);
  return Math.min(1, scale);
}

function centeredPosition(scale) {
  return {
    x: (stage.clientWidth - picture.naturalWidth * scale) / 2,
    y: (stage.clientHeight - picture.naturalHeight * scale) / 2,
  };
}

function draw() {
  picture.style.transform = 'translate(' + view.x + 'px,' + view.y + 'px) scale(' + view.scale + ')';
  picture.classList.toggle('pixel', view.scale >= 3);
}

function showBadge(badge, text, timerName) {
  badge.textContent = text;
  badge.classList.add('show');
  if (timerName === 'zoom') {
    clearTimeout(zoomBadgeTimer);
    zoomBadgeTimer = setTimeout(() => badge.classList.remove('show'), BADGE_MS);
  } else {
    clearTimeout(nameBadgeTimer);
    nameBadgeTimer = setTimeout(() => badge.classList.remove('show'), BADGE_MS + 600);
  }
}

function showZoom() {
  showBadge(zoomBadge, Math.round(target.scale * 100) + '%', 'zoom');
}

function step(now) {
  const progress = Math.min(1, (now - animationStart) / ANIMATION_MS);
  const eased = 1 - Math.pow(1 - progress, 3);
  view.scale = animationFrom.scale + (target.scale - animationFrom.scale) * eased;
  view.x = animationFrom.x + (target.x - animationFrom.x) * eased;
  view.y = animationFrom.y + (target.y - animationFrom.y) * eased;
  draw();
  if (progress < 1) {
    requestAnimationFrame(step);
  } else {
    animating = false;
  }
}

function animateTo(scale, x, y) {
  target.scale = scale;
  target.x = x;
  target.y = y;
  animationFrom = { scale: view.scale, x: view.x, y: view.y };
  animationStart = performance.now();
  if (!animating) {
    animating = true;
    requestAnimationFrame(step);
  }
}

function jumpTo(scale, x, y) {
  animating = false;
  view.scale = target.scale = scale;
  view.x = target.x = x;
  view.y = target.y = y;
  draw();
}

// Zoom keeping the image point under (px, py) fixed, based on the target state
function zoomAbout(newScale, px, py) {
  if (!loaded) return;
  const scale = clampZoom(newScale);
  const ratio = scale / target.scale;
  fitMode = false;
  animateTo(scale, px - (px - target.x) * ratio, py - (py - target.y) * ratio);
  showZoom();
}

function fit(animate) {
  if (!loaded) return;
  const scale = fitScale();
  const position = centeredPosition(scale);
  fitMode = true;
  if (animate) animateTo(scale, position.x, position.y);
  else jumpTo(scale, position.x, position.y);
  showZoom();
}

function actualSize(px, py) {
  zoomAbout(1, px, py);
}

function centerX() { return stage.clientWidth / 2; }
function centerY() { return stage.clientHeight / 2; }

stage.addEventListener('wheel', (event) => {
  event.preventDefault();
  let delta = event.deltaY;
  if (event.deltaMode === 1) delta *= 16;
  else if (event.deltaMode === 2) delta *= 100;
  const speed = event.ctrlKey ? 0.01 : 0.0015;
  zoomAbout(target.scale * Math.exp(-delta * speed), event.clientX, event.clientY);
}, { passive: false });

let dragging = false;
let dragLastX = 0;
let dragLastY = 0;

stage.addEventListener('mousedown', (event) => {
  if (event.button !== 0 || !loaded) return;
  dragging = true;
  dragLastX = event.clientX;
  dragLastY = event.clientY;
  stage.classList.add('dragging');
});

window.addEventListener('mousemove', (event) => {
  if (!dragging) return;
  const dx = event.clientX - dragLastX;
  const dy = event.clientY - dragLastY;
  dragLastX = event.clientX;
  dragLastY = event.clientY;
  fitMode = false;
  animating = false;
  view.x = target.x = target.x + dx;
  view.y = target.y = target.y + dy;
  view.scale = target.scale;
  requestAnimationFrame(draw);
});

window.addEventListener('mouseup', () => {
  dragging = false;
  stage.classList.remove('dragging');
});

stage.addEventListener('dblclick', (event) => {
  if (!loaded) return;
  if (Math.abs(target.scale - 1) < 0.001) fit(true);
  else actualSize(event.clientX, event.clientY);
});

let lastWidth = 0;
let lastHeight = 0;

window.addEventListener('resize', () => {
  if (!loaded) return;
  if (fitMode) {
    fit(true);
  } else {
    // keep the center point: shift by half the size change
    const dx = (stage.clientWidth - lastWidth) / 2;
    const dy = (stage.clientHeight - lastHeight) / 2;
    jumpTo(target.scale, target.x + dx, target.y + dy);
  }
  lastWidth = stage.clientWidth;
  lastHeight = stage.clientHeight;
});

window.addEventListener('keydown', (event) => {
  const key = event.key;
  if (key === 'Escape' || (event.ctrlKey && key.toLowerCase() === 'w')) {
    window.viewer.close();
  } else if (key === 'f' || key === 'F' || key === 'F11') {
    event.preventDefault();
    window.viewer.toggleFullscreen();
  } else if (key === '0') {
    fit(true);
  } else if (key === '1') {
    actualSize(centerX(), centerY());
  } else if (key === '+' || key === '=') {
    zoomAbout(target.scale * 1.25, centerX(), centerY());
  } else if (key === '-' || key === '_') {
    zoomAbout(target.scale / 1.25, centerX(), centerY());
  }
});

picture.addEventListener('load', () => {
  loaded = true;
  picture.style.display = 'block';
  picture.style.width = picture.naturalWidth + 'px';
  picture.style.height = picture.naturalHeight + 'px';
  lastWidth = stage.clientWidth;
  lastHeight = stage.clientHeight;
  fit(false);
  showBadge(nameBadge, params.get('name') || '', 'name');
});

picture.addEventListener('error', () => {
  errorLine.textContent = 'Could not load ' + (params.get('name') || 'image');
  errorLine.style.display = 'block';
});

const source = params.get('src');
if (source) {
  picture.src = source;
} else {
  errorLine.textContent = 'No image given';
  errorLine.style.display = 'block';
}
