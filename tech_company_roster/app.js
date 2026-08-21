const select = document.getElementById('employeeSelect');
const details = document.getElementById('details');
const photoImg = document.getElementById('photoImg');
const nameMain = document.getElementById('nameMain');
const pillRole = document.getElementById('pillRole');
const pillDept = document.getElementById('pillDept');
const pillId = document.getElementById('pillId');
const pillAccess = document.getElementById('pillAccess');
const downloadBtn = document.getElementById('downloadBtn');
const printBtn = document.getElementById('printBtn');
const photoFrame = document.querySelector('.photo-frame');

// Portrait scale, as a fraction of `cover`. 1.0 = fill the frame but crop ~27%
// off each side; 0.80 keeps the side components visible. The image is pinned to
// the frame bottom so the subject never floats. Must stay in sync with the
// width/height percentages on .photo-img in style.css.
const PHOTO_ZOOM = 0.80;

// The zoomed-out portrait leaves a gap above it. Fill that gap with a gradient
// sampled across the portrait's own top edge so the backdrop continues
// seamlessly instead of showing a hard band.
function paintPhotoBackdrop(img) {
  if (!photoFrame) return;
  try {
    const probe = document.createElement('canvas');
    const STOPS = 5;
    probe.width = STOPS; probe.height = 1;
    const pctx = probe.getContext('2d', { willReadFrequently: true });
    // average the top 2% of the image down to STOPS horizontal samples
    pctx.drawImage(img, 0, 0, img.naturalWidth, Math.max(1, img.naturalHeight * 0.02), 0, 0, STOPS, 1);
    const d = pctx.getImageData(0, 0, STOPS, 1).data;
    const stops = [];
    for (let i = 0; i < STOPS; i++) {
      const o = i * 4;
      stops.push(`rgb(${d[o]},${d[o+1]},${d[o+2]}) ${(i / (STOPS - 1) * 100).toFixed(0)}%`);
    }
    photoFrame.style.setProperty('--photo-bg', `linear-gradient(90deg, ${stops.join(',')})`);
  } catch (e) {
    // getImageData taints on file:// origins — fall back to the card's own navy
    photoFrame.style.setProperty('--photo-bg', '#1a1740');
  }
}

let roster = null;
let current = null;

// Derived mappings — keep in sync with company_roster.json:6
function inferDepartment(p) {
  const t = (p.role?.title || '').toLowerCase();
  const id = p.id || '';
  if (id === 'leila-haddad' || t.includes('chief technology officer')) return 'Executive Leadership';
  if (id === 'adrian-cole' || t.includes('chief information security')) return 'Security • Executive';
  // Use short "Data" to match DATAVISTA reference (Maya Chen → Data)
  if (t.includes('data') || t.includes('analytics')) return 'Data';
  if (t.includes('cybersecurity') || t.includes('security')) return 'Security';
  if (t.includes('product')) return 'Product & Design';
  if (t.includes('program manager') || t.includes('tpm')) return 'Program Management';
  if (t.includes('hardware') || t.includes('electronics')) return 'Hardware Engineering';
  // engineering bucket
  if (t.includes('frontend') || t.includes('backend') || t.includes('devops') || t.includes('qa') || t.includes('engineering manager') || t.includes('sre')) return 'Engineering';
  return 'Engineering';
}

function shortRoleTitle(title) {
  // Shorten long titles to match card aesthetics like reference: "VP Data & Analytics"
  const t = title || '';
  if (/vice president/i.test(t) && /data/i.test(t)) return 'VP Data & Analytics';
  if (/chief technology officer/i.test(t)) return 'CTO';
  if (/chief information security/i.test(t)) return 'CISO';
  if (/principal electronics/i.test(t)) return 'Principal Hardware Engineer';
  if (/senior devops/i.test(t)) return 'Senior DevOps / SRE';
  return t;
}

function formatDisplayName(fullName) {
  // Strip leading Dr. etc. to match reference (Maya Chen not Dr. Maya Chen)
  let n = (fullName || '').replace(/^Dr\.?\s+/i, '').trim();
  // Split into lines for large display: "Maya Chen" → ["Maya","Chen"]
  // If 3+ parts, group all but last as first line: "Elena Vargas" → ["Elena","Vargas"], "Dr. Mei Lin" already stripped → ["Mei","Lin"]
  const parts = n.split(/\s+/);
  if (parts.length <= 2) return parts;
  return [parts.slice(0, -1).join(' '), parts.slice(-1)[0]];
}

function formatEmployeeId(p, index) {
  // Match DATAVISTA reference: "ID: 10427" — sequential starting at 10415 so Maya (idx 12) → 10427
  const num = 10415 + (index ?? 0);
  return `ID: ${num}`;
}

function getAccessLevel(p) {
  const t = (p.role?.title || '').toLowerCase();
  const years = p.role?.years_of_experience ?? 0;
  let level = 2;
  if (t.includes('chief') || t.includes('vice president') || t.includes('cto') || t.includes('ciso')) {
    level = 5;
  } else if (t.includes('principal') || t.includes('staff') || t.includes('lead') || t.includes('director') || t.includes('manager')) {
    level = 4;
  } else if (t.includes('senior')) {
    level = 3;
  } else {
    level = 2;
  }
  if (years >= 15 && level < 5) level = Math.min(5, level+1);
  else if (years >= 10 && level < 4) level = 4;
  // Match reference: "Level 5 Access"
  return `Level ${level} Access`;
}

function renderDetails(p) {
  if (!p) { details.innerHTML = ''; return; }
  const strengths = (p.strengths?.fields_and_components || []).slice(0,6).map(s=>`<span class="tag">${s}</span>`).join('');
  const animal = p.animal_analogy ? `${p.animal_analogy.animal} — ${p.animal_analogy.why}` : '';
  details.innerHTML = `
    <h3>${p.full_name}</h3>
    <div class="field"><strong>${p.role.title}</strong> • ${p.role.experience_summary || ''}</div>
    <div class="field" style="color:var(--muted)">${p.short_description || ''}</div>
    <div class="field"><strong>Tone:</strong> <span style="color:var(--muted)">${p.tone || ''}</span></div>
    <div class="field"><strong>Animal:</strong> <span style="color:var(--muted)">${animal}</span></div>
    <div class="field"><strong>Call them when:</strong><br><span style="color:var(--muted);font-size:12px">${(p.strengths?.you_call_them_when||[]).slice(0,3).join(' • ')}</span></div>
    <div class="field"><div style="margin-top:6px">${strengths}</div></div>
    <div class="field" style="margin-top:8px;color:#8f8cb3;font-size:11px">Image: <code>${p.image?.relative_url || ''}</code></div>
  `;
}

function applyProfile(p, index) {
  current = p;
  if (!p) return;
  // photo — company_roster.json:41 relative_url
  const rel = p.image?.relative_url || '';
  // Images live in images/ next to this file; ensure path is correct
  photoImg.src = rel;
  photoImg.alt = p.full_name || 'Employee';
  // Ensure cover behavior (CSS) — also handle load error
  photoImg.onerror = () => {
    photoImg.style.display = 'none';
    photoFrame?.style.setProperty('--photo-bg', '#1a1740');
  };
  photoImg.onload = () => {
    photoImg.style.display = 'block';
    paintPhotoBackdrop(photoImg);
  };

  // Name above ROLE — large, two-line like DATAVISTA reference
  const parts = formatDisplayName(p.full_name || '');
  // Clear and append with <br>
  nameMain.innerHTML = '';
  parts.forEach((part, i) => {
    const span = document.createElement('span');
    span.textContent = part;
    span.style.display = 'block';
    nameMain.appendChild(span);
  });
  // Auto-adjust font size for long names (e.g., "Alexandrina Montgomery")
  const fullLen = (p.full_name || '').length;
  if (fullLen > 18) nameMain.style.fontSize = '18px';
  else if (fullLen > 14) nameMain.style.fontSize = '20px';
  else nameMain.style.fontSize = '22px';

  pillRole.textContent = shortRoleTitle(p.role?.title || '');
  pillDept.textContent = inferDepartment(p);
  pillId.textContent = formatEmployeeId(p, index);
  pillAccess.textContent = getAccessLevel(p);

  // Auto-shrink text if overflow (pill is 26% width ~110px). Measure and reduce font-size.
  [pillRole, pillDept, pillId, pillAccess].forEach(el => {
    el.style.fontSize = '9px';
    // if text is long, reduce
    const len = (el.textContent || '').length;
    if (len > 24) el.style.fontSize = '7.5px';
    else if (len > 20) el.style.fontSize = '8px';
  });

  renderDetails(p);
}

async function loadRoster() {
  const res = await fetch('company_roster.json');
  if (!res.ok) throw new Error(`Failed to load company_roster.json: ${res.status}`);
  const data = await res.json();
  roster = data.profiles || [];
  // populate select
  select.innerHTML = roster.map((p,i)=> `<option value="${p.id}">${p.full_name} — ${p.role.title}</option>`).join('');
  // select first
  if (roster.length) {
    select.value = roster[0].id;
    applyProfile(roster[0], 0);
  }
  select.addEventListener('change', () => {
    const id = select.value;
    const idx = roster.findIndex(p=>p.id===id);
    const p = roster[idx];
    if (p) applyProfile(p, idx);
  });
}

// Export via canvas — native 1023x1537, covers photo without warping
async function exportPNG() {
  if (!current) return;
  const canvas = document.getElementById('exportCanvas');
  const ctx = canvas.getContext('2d');
  const W = 1023, H = 1537;
  canvas.width = W; canvas.height = H;

  // helpers
  const loadImg = (src) => new Promise((resolve, reject) => {
    const img = new Image();
    // local images are same-origin, but set anonymous to be safe
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });

  // template is emploee-card.png (note typo) at root — same as <img src>
  const templateSrc = 'emploee-card.png';
  const profileSrc = current.image?.relative_url || '';

  let templateImg, profileImg;
  try {
    templateImg = await loadImg(templateSrc);
  } catch (e) {
    alert('Failed to load template image: ' + templateSrc);
    return;
  }
  try {
    profileImg = await loadImg(profileSrc);
  } catch (e) {
    console.warn('profile image failed', e);
  }

  // clear and draw template
  ctx.clearRect(0,0,W,H);
  ctx.drawImage(templateImg, 0, 0, W, H);

  // photo rect — validated via python: 112,486,530,1060
  const photoRect = { x:112, y:486, w:530-112, h:1060-486 }; // 418x574

  if (profileImg) {
    // portrait: zoomed out from cover and bottom-pinned, gap filled from its own edges
    const iw = profileImg.naturalWidth || profileImg.width;
    const ih = profileImg.naturalHeight || profileImg.height;
    const rectW = photoRect.w, rectH = photoRect.h;
    // clip with rounded rect (approx 14px radius, plus small pixel notch ignored)
    ctx.save();
    const r = 14;
    ctx.beginPath();
    ctx.moveTo(photoRect.x + r, photoRect.y);
    ctx.lineTo(photoRect.x + photoRect.w - r, photoRect.y);
    ctx.quadraticCurveTo(photoRect.x + photoRect.w, photoRect.y, photoRect.x + photoRect.w, photoRect.y + r);
    ctx.lineTo(photoRect.x + photoRect.w, photoRect.y + photoRect.h - r);
    ctx.quadraticCurveTo(photoRect.x + photoRect.w, photoRect.y + photoRect.h, photoRect.x + photoRect.w - r, photoRect.y + photoRect.h);
    ctx.lineTo(photoRect.x + r, photoRect.y + photoRect.h);
    ctx.quadraticCurveTo(photoRect.x, photoRect.y + photoRect.h, photoRect.x, photoRect.y + photoRect.h - r);
    ctx.lineTo(photoRect.x, photoRect.y + r);
    ctx.quadraticCurveTo(photoRect.x, photoRect.y, photoRect.x + r, photoRect.y);
    ctx.closePath();
    ctx.clip();
    // draw profile at PHOTO_ZOOM of cover, pinned to the frame bottom
    const scale = Math.max(rectW / iw, rectH / ih) * PHOTO_ZOOM;
    const destW = iw * scale;
    const destH = ih * scale;
    const destX = photoRect.x + (rectW - destW) / 2;
    const destY = photoRect.y + (rectH - destH); // bottom-aligned

    // Fill the gap above (and beside, if any) by stretching the image's own
    // outermost pixels outward — mirrors the --photo-bg gradient in the preview.
    const edge = Math.max(2, Math.round(ih * 0.01));
    if (destY > photoRect.y) {
      ctx.drawImage(profileImg, 0, 0, iw, edge, destX, photoRect.y, destW, destY - photoRect.y);
    }
    if (destX > photoRect.x) {
      const pad = destX - photoRect.x;
      ctx.drawImage(profileImg, 0, 0, edge, ih, photoRect.x, destY, pad, destH);
      ctx.drawImage(profileImg, iw - edge, 0, edge, ih, destX + destW, destY, pad, destH);
      if (destY > photoRect.y) {
        ctx.drawImage(profileImg, 0, 0, edge, edge, photoRect.x, photoRect.y, pad, destY - photoRect.y);
        ctx.drawImage(profileImg, iw - edge, 0, edge, edge, destX + destW, photoRect.y, pad, destY - photoRect.y);
      }
    }
    ctx.drawImage(profileImg, destX, destY, destW, destH);
    ctx.restore();

    // optional: redraw inner border to keep crisp edge (1.5px light purple)
    ctx.save();
    ctx.strokeStyle = 'rgba(122,92,255,0.55)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(photoRect.x + r, photoRect.y);
    ctx.lineTo(photoRect.x + photoRect.w - r, photoRect.y);
    ctx.quadraticCurveTo(photoRect.x + photoRect.w, photoRect.y, photoRect.x + photoRect.w, photoRect.y + r);
    ctx.lineTo(photoRect.x + photoRect.w, photoRect.y + photoRect.h - r);
    ctx.quadraticCurveTo(photoRect.x + photoRect.w, photoRect.y + photoRect.h, photoRect.x + photoRect.w - r, photoRect.y + photoRect.h);
    ctx.lineTo(photoRect.x + r, photoRect.y + photoRect.h);
    ctx.quadraticCurveTo(photoRect.x, photoRect.y + photoRect.h, photoRect.x, photoRect.y + photoRect.h - r);
    ctx.lineTo(photoRect.x, photoRect.y + r);
    ctx.quadraticCurveTo(photoRect.x, photoRect.y, photoRect.x + r, photoRect.y);
    ctx.closePath();
    ctx.stroke();
    ctx.restore();
  }

  // pills text — positions as in CSS, using native coordinates
  // helper to draw centered text inside pill rect
  function drawPillText(text, rect) {
    // auto fit font size
    let fontSize = 15;
    if (text.length > 24) fontSize = 11;
    else if (text.length > 20) fontSize = 12.5;
    else if (text.length > 16) fontSize = 13.5;
    ctx.font = `800 ${fontSize}px Inter, system-ui, sans-serif`;
    ctx.fillStyle = 'white';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // subtle shadow
    ctx.shadowColor = 'rgba(0,0,0,0.65)';
    ctx.shadowBlur = 4;
    ctx.shadowOffsetY = 1;
    const cx = rect.x + rect.w/2;
    const cy = rect.y + rect.h/2;
    ctx.fillText(text, cx, cy);
    ctx.shadowBlur = 0;
  }

  const idx = roster.findIndex(p=>p.id===current.id);
  const pillRects = [
    { x:652, y:678, w:266, h:42, text: shortRoleTitle(current.role?.title || '') },
    { x:652, y:801, w:267, h:42, text: inferDepartment(current) },
    { x:652, y:919, w:267, h:33, text: formatEmployeeId(current, idx) },
    { x:652, y:1035, w:267, h:35, text: getAccessLevel(current) },
  ];
  // For pill 3 and 4 height was 33/35 but center differently; adjust to use center 935 and 1052 with h 42 for visual centering
  // Recalibrate pills 3/4 to h 42 centered
  pillRects[2] = { x:652, y:935-21, w:267, h:42, text: formatEmployeeId(current, idx) };
  pillRects[3] = { x:652, y:1052-21, w:267, h:42, text: getAccessLevel(current) };

  pillRects.forEach(r => drawPillText(r.text, r));

  // Name above ROLE — DATAVISTA style: large white, left-aligned, two lines, above thin line (590,505)
  const displayParts = formatDisplayName(current.full_name || '');
  ctx.fillStyle = 'white';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.shadowColor = 'rgba(0,0,0,0.85)';
  ctx.shadowBlur = 8;
  ctx.shadowOffsetY = 2;
  const nameX = 590; // 57.67% of 1023
  const nameY0 = 505; // 32.85% of 1537
  // Choose font size adaptively: longer names smaller
  const joinedLen = (current.full_name || '').replace(/^Dr\.?\s+/i,'').length;
  let nameFontSize = 52;
  if (joinedLen > 16) nameFontSize = 46;
  if (joinedLen > 20) nameFontSize = 40;
  ctx.font = `900 ${nameFontSize}px Inter, system-ui, sans-serif`;
  displayParts.forEach((line, i) => {
    const y = nameY0 + i * (nameFontSize * 0.95);
    // shadow already set
    ctx.fillText(line, nameX, y);
  });
  ctx.shadowBlur = 0;

  // trigger download
  const dataURL = canvas.toDataURL('image/png');
  const a = document.createElement('a');
  a.href = dataURL;
  const safeName = (current.id || 'employee').replace(/[^a-z0-9_-]/gi,'-');
  a.download = `NJ-LABS-card-${safeName}.png`;
  a.click();
}

downloadBtn.addEventListener('click', exportPNG);
printBtn.addEventListener('click', ()=> window.print());

// init
loadRoster().catch(err=>{
  details.innerHTML = `<div style="color:#ff6b6b">Error: ${err.message}</div>`;
  console.error(err);
});
