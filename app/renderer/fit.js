'use strict';

// Keep the device scale stable; narrow windows shrink, wider ones get a larger viewport.
const cfg = JSON.parse(new URLSearchParams(location.search).get('cfg'));
const surface = document.getElementById('surface');
const drag = document.getElementById('drag');
const size = cfg.fit;
document.body.style.background = cfg.theme?.background || '#000';
surface.style.width = `${size.width}px`;
surface.style.height = `${size.height}px`;
function fit() {
  if (!(innerWidth > 0 && innerHeight > 0)) return;
  const scale = Math.min(1, innerWidth / size.width);
  const width = innerWidth / scale, height = innerHeight / scale;
  const x = 0, y = 0;
  surface.style.width = `${width}px`;
  surface.style.height = `${height}px`;
  surface.style.left = `${x}px`;
  surface.style.top = `${y}px`;
  surface.style.transform = `scale(${scale})`;
  Object.assign(drag.style,{left:'0px',top:'0px',width:`${innerWidth}px`,height:`${(cfg.padding??18)*scale}px`});
  window.r7CanvasFit = { scale, x, y, width, height };
}
function rectToWindow(rect) {
  if (!rect) return rect;
  const {scale,x,y} = window.r7CanvasFit;
  return { x:Math.round(x+rect.x*scale), y:Math.round(y+rect.y*scale), width:Math.round(rect.width*scale), height:Math.round(rect.height*scale) };
}
// The child uses the existing preload API, without Node access.
window.r7Surface = {
  ...window.r7,
  snapshot: rect => window.r7.snapshot(rectToWindow(rect)),
  pictureMenu: (target,x,y) => {
    const f = window.r7CanvasFit;
    window.r7.pictureMenu(target,Math.round(f.x+x*f.scale),Math.round(f.y+y*f.scale));
  },
};
fit();
addEventListener('resize',fit);
addEventListener('mousedown',event => {
  if (event.target === surface || event.target === drag) return;
  event.preventDefault();
  surface.contentWindow.focus();
});
surface.src = `index.html?${new URLSearchParams({cfg:JSON.stringify(cfg)})}`;
