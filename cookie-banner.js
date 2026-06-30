(function () {
  if (localStorage.getItem('cookie_consent') === '1') return;

  var style = document.createElement('style');
  style.textContent = [
    '#onda-cookie{',
      'position:fixed;bottom:0;left:0;right:0;z-index:9999;',
      'background:#0c0b14;color:rgba(255,255,255,0.85);',
      'padding:16px 24px;',
      'display:flex;align-items:center;justify-content:space-between;gap:16px;',
      'font-family:"DM Sans",system-ui,sans-serif;font-size:14px;line-height:1.5;',
      'border-top:1px solid rgba(255,255,255,0.08);',
      'animation:onda-slide-up 0.3s ease;',
    '}',
    '@keyframes onda-slide-up{from{transform:translateY(100%)}to{transform:translateY(0)}}',
    '#onda-cookie p{margin:0;max-width:680px;}',
    '#onda-cookie a{color:#1D9E75;text-decoration:underline;}',
    '#onda-cookie-actions{display:flex;gap:10px;flex-shrink:0;}',
    '.onda-btn{',
      'padding:9px 20px;border-radius:8px;font-size:13px;font-weight:600;',
      'cursor:pointer;border:none;white-space:nowrap;transition:opacity 0.15s;',
    '}',
    '.onda-btn:hover{opacity:0.85;}',
    '.onda-btn-accept{background:#1D9E75;color:#fff;}',
    '.onda-btn-info{background:rgba(255,255,255,0.1);color:rgba(255,255,255,0.75);}',
    '@media(max-width:600px){',
      '#onda-cookie{flex-direction:column;align-items:flex-start;}',
      '#onda-cookie-actions{width:100%;}',
      '.onda-btn{flex:1;text-align:center;}',
    '}',
  ].join('');
  document.head.appendChild(style);

  var banner = document.createElement('div');
  banner.id = 'onda-cookie';
  banner.innerHTML = [
    '<p>🔒 Questo sito usa <strong>cookie tecnici</strong> necessari per autenticazione e pagamenti sicuri.',
    ' Nessun cookie di profilazione o marketing.',
    ' <a href="/privacy.html">Leggi la Privacy Policy</a></p>',
    '<div id="onda-cookie-actions">',
      '<button class="onda-btn onda-btn-info" id="onda-info-btn">Dettagli</button>',
      '<button class="onda-btn onda-btn-accept" id="onda-accept-btn">Ho capito</button>',
    '</div>',
  ].join('');
  document.body.appendChild(banner);

  document.getElementById('onda-accept-btn').addEventListener('click', function () {
    localStorage.setItem('cookie_consent', '1');
    banner.style.animation = 'onda-slide-up 0.2s ease reverse';
    setTimeout(function () { banner.remove(); }, 200);
  });

  document.getElementById('onda-info-btn').addEventListener('click', function () {
    window.location.href = '/privacy.html#cookie';
  });
}());
