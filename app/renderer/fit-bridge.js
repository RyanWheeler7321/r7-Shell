'use strict';
// A fitted frame uses its host's existing sandboxed preload bridge.
if (parent !== window && !window.r7) window.r7 = parent.r7Surface;
