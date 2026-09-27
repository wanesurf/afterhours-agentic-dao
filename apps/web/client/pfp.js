import Cropper from 'cropperjs';

const $ = id => document.getElementById(id);
const frame = $('portrait-frame');
const host = $('cropper-host');
const stage = $('portrait-stage');
const range = $('zoom');
let cropper, cropImage, objectUrl, baseScale = 1, busy = false, frameReady = false, raf = 0, paintRevision = 0;
let imageName = 'afterhours', hasPicture = false, imageWidth = 0, imageHeight = 0;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
function status(message, error = false) {
  $('pfp-status').textContent = message; $('pfp-status').hidden = !message;
  $('pfp-status').toggleAttribute('data-error', error);
}
function controls() {
  $('fetch-avatar').disabled = busy;
  $('upload-picture').disabled = busy;
  $('x-handle').disabled = busy;
  $('adjustments').disabled = !hasPicture || busy;
  $('save-pfp').disabled = !hasPicture || !frameReady || busy;
  if (cropper) cropper.getCropperCanvas().disabled = busy;
}
async function composite(size) {
  const canvas = hasPicture ? await cropper.getCropperCanvas().$toCanvas({
    width: size, height: size,
    beforeDraw(context, result) { context.fillStyle = '#f1f0e9'; context.fillRect(0, 0, result.width, result.height); },
  }) : Object.assign(document.createElement('canvas'), { width: size, height: size });
  const context = canvas.getContext('2d');
  if (!hasPicture) { context.fillStyle = '#f1f0e9'; context.fillRect(0, 0, size, size); }
  if (frameReady) context.drawImage(frame, 0, 0, size, size);
  return canvas;
}
function updatePreviews() {
  const revision = ++paintRevision;
  if (raf) cancelAnimationFrame(raf);
  raf = requestAnimationFrame(async () => {
    raf = 0;
    try {
      const result = await composite(192);
      if (revision !== paintRevision) return;
      for (const id of ['preview-large', 'preview-small']) {
        const target = $(id), ctx = target.getContext('2d'); ctx.clearRect(0, 0, target.width, target.height); ctx.drawImage(result, 0, 0, target.width, target.height);
      }
    } catch { /* A replacement image may still be decoding; the next change redraws. */ }
  });
}
function syncZoom() {
  if (!cropImage || !hasPicture) return;
  const percent = Math.round(cropImage.$getTransform()[0] / baseScale * 100);
  range.value = String(clamp(percent, 40, 400)); $('zoom-value').value = `${percent}%`;
  updatePreviews();
}
function setZoom(percent) {
  if (!hasPicture || busy) return;
  const target = baseScale * clamp(percent, 40, 400) / 100;
  cropImage.$scale(target / cropImage.$getTransform()[0]);
}
function fitPicture() {
  const { width, height } = stage.getBoundingClientRect();
  baseScale = Math.max(width / imageWidth, height / imageHeight);
  cropImage.$setTransform(baseScale, 0, 0, baseScale, (width - imageWidth) / 2, (height - imageHeight) / 2);
}
async function loadPicture(blob, label) {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(blob.type)) throw new Error('Choose a JPG, PNG or WebP picture.');
  if (!blob.size || blob.size > 10 * 1024 * 1024) throw new Error('Choose a picture smaller than 10 MB.');
  const nextUrl = URL.createObjectURL(blob), image = new Image(); image.src = nextUrl;
  try { await image.decode(); } catch { URL.revokeObjectURL(nextUrl); throw new Error('This file could not be opened as a picture. Try a JPG, PNG or WebP.'); }
  if (image.naturalWidth * image.naturalHeight > 40_000_000) { URL.revokeObjectURL(nextUrl); throw new Error('Choose a picture with fewer than 40 million pixels.'); }
  host.replaceChildren(); hasPicture = false; ++paintRevision;
  if (objectUrl) URL.revokeObjectURL(objectUrl); objectUrl = nextUrl;
  cropper = new Cropper(image, { container: host, template: '<cropper-canvas><cropper-image initial-center-size="cover" scalable translatable></cropper-image><cropper-handle action="move" plain></cropper-handle></cropper-canvas>' });
  cropImage = cropper.getCropperImage(); await cropImage.$ready();
  imageWidth = image.naturalWidth; imageHeight = image.naturalHeight;
  // A cached image can resolve $ready before its initial layout finishes.
  // Use natural dimensions for a stable 100% cover fit.
  fitPicture(); previousWidth = stage.getBoundingClientRect().width;
  cropImage.addEventListener('transform', event => {
    if (!hasPicture) return;
    const zoom = event.detail.matrix[0] / baseScale;
    if (!Number.isFinite(zoom) || zoom < .399 || zoom > 4.001) { event.preventDefault(); return; }
    requestAnimationFrame(syncZoom);
  });
  hasPicture = true; imageName = label.replace(/[^a-z0-9_-]/gi, '').slice(0, 40) || 'afterhours';
  stage.setAttribute('data-loaded', ''); $('empty-portrait').hidden = true;
  $('preview-help').textContent = 'Drag your picture. Pinch or scroll to zoom.';
  syncZoom(); controls();
  return image.naturalWidth;
}
$('upload-picture').addEventListener('change', async event => {
  const file = event.target.files?.[0]; if (!file || busy) return;
  busy = true; controls(); status('Opening your picture…');
  try { await loadPicture(file, file.name.replace(/\.[^.]+$/, '')); status('Picture added. Drag it behind the arch to find your framing.'); }
  catch (error) { status(error.message, true); }
  finally { busy = false; event.target.value = ''; controls(); }
});
$('x-form').addEventListener('submit', async event => {
  event.preventDefault(); if (busy) return;
  const handle = $('x-handle').value.trim(); if (!handle) { status('Enter your X handle or upload a picture.', true); $('x-handle').focus(); return; }
  busy = true; controls(); $('fetch-avatar').textContent = 'Finding…'; status('Looking up your public X picture…');
  try {
    const response = await fetch(`/api/pfp/avatar?handle=${encodeURIComponent(handle)}`, { signal: AbortSignal.timeout(16_000) });
    if (!response.ok) { const payload = await response.json().catch(() => ({})); throw new Error(payload.error || 'X lookup is unavailable. Upload your picture instead.'); }
    const name = response.headers.get('x-avatar-handle') || 'afterhours';
    const width = await loadPicture(await response.blob(), name);
    status(width < 400 ? 'Picture found. For a sharper result, you can upload the original image.' : 'Picture found. Adjust your framing, then save your portrait.');
  } catch (error) { status(error.name === 'TimeoutError' ? 'X is taking too long. Upload your picture instead.' : error.message, true); }
  finally { busy = false; $('fetch-avatar').textContent = 'Find picture'; controls(); }
});
range.addEventListener('input', () => setZoom(Number(range.value)));
$('zoom-in').addEventListener('click', () => setZoom(Number(range.value) + 10));
$('zoom-out').addEventListener('click', () => setZoom(Number(range.value) - 10));
$('reset-picture').addEventListener('click', () => {
  if (!hasPicture || busy) return;
  // Temporarily remove the limit while returning to the initial fit.
  hasPicture = false; fitPicture(); hasPicture = true; syncZoom();
});
function move(x, y, multiplier = 1) { if (hasPicture && !busy) cropImage.$move(x * stage.clientWidth * .025 * multiplier, y * stage.clientHeight * .025 * multiplier); }
for (const button of document.querySelectorAll('[data-move]')) button.addEventListener('click', () => move(...button.dataset.move.split(',').map(Number)));
stage.addEventListener('keydown', event => {
  if (!hasPicture || busy) return;
  const directions = { ArrowLeft: [-1,0], ArrowRight: [1,0], ArrowUp: [0,-1], ArrowDown: [0,1] };
  if (directions[event.key]) { event.preventDefault(); move(...directions[event.key], event.shiftKey ? 3 : 1); }
  else if (['+', '=', '-'].includes(event.key)) { event.preventDefault(); setZoom(Number(range.value) + (event.key === '-' ? -10 : 10)); }
});
let previousWidth = stage.getBoundingClientRect().width;
new ResizeObserver(() => {
  const width = stage.getBoundingClientRect().width;
  if (hasPicture && previousWidth && width !== previousWidth) {
    const ratio = width / previousWidth, matrix = cropImage.$getTransform();
    baseScale *= ratio;
    // Cropper's transform origin is the natural image's center. Preserve
    // its normalized position as the square editor changes size.
    cropImage.$setTransform([
      matrix[0] * ratio, matrix[1] * ratio, matrix[2] * ratio, matrix[3] * ratio,
      (matrix[4] + imageWidth / 2) * ratio - imageWidth / 2,
      (matrix[5] + imageHeight / 2) * ratio - imageHeight / 2,
    ]);
    syncZoom();
  }
  previousWidth = width;
}).observe(stage);
$('save-pfp').addEventListener('click', async () => {
  if ($('save-pfp').disabled) return;
  busy = true; controls(); $('save-label').textContent = 'Preparing PNG…';
  try {
    const result = await composite(1024);
    const blob = await new Promise(resolve => result.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('Could not save this picture. Try uploading it again.');
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = `afterhours-${imageName}.png`; document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    status('Your PNG is ready. Set it as your profile picture on X.');
  } catch (error) { status(error.message || 'Could not save your portrait. Try again.', true); }
  finally { busy = false; $('save-label').textContent = 'Save your portrait'; controls(); }
});
controls();
frame.decode().then(() => { frameReady = true; controls(); updatePreviews(); }).catch(() => status('The Afterhours frame could not load. Refresh the page to try again.', true));
