(async function init() {
  const prefs = (await window.crabAPI.getPrefs()) || {};

  const $ = (id) => document.getElementById(id);
  const petName = $('petName');
  const elKey = $('elKey');
  const personality = $('personality');
  const skin = $('skin');
  const speed = $('speed');
  const speedVal = $('speedVal');
  const color = $('color');
  const colorVal = $('colorVal');
  const sleepMin = $('sleepMin');
  const sleepMinVal = $('sleepMinVal');

  petName.value = prefs.petName || 'clawd';
  elKey.value = prefs.elevenLabsKey || '';
  personality.value = prefs.personality || 'default';
  skin.value = prefs.skin || 'default';
  speed.value = prefs.crabSpeed != null ? prefs.crabSpeed : 0.5;
  speedVal.textContent = parseFloat(speed.value).toFixed(1);
  color.value = prefs.crabColor || '#CC785C';
  colorVal.textContent = color.value.toUpperCase();
  sleepMin.value = prefs.sleepMinutes != null ? prefs.sleepMinutes : 3;
  sleepMinVal.textContent = sleepMin.value;

  // Swatch shown next to the skin dropdown — matches the chosen skin's body color.
  const skinSwatch = $('skinSwatch');
  const SKIN_COLORS = {
    default: '#CC785C',
    hacker: '#1AAF5D',
    ghost: '#F5F5F5',
    sushi: '#E8769A',
    royal: '#7B5BAD',
    boba: '#D4A574',
    cyberpunk: '#FF1493',
    shadow: '#2C2C2C',
  };

  // Color picker only matters when the Custom skin is selected. Swatch reflects
  // either the preset color or the user's custom pick.
  function refreshColorState() {
    const isCustom = skin.value === 'custom';
    color.disabled = !isCustom;
    color.style.opacity = isCustom ? '1' : '0.4';
    skinSwatch.style.background = isCustom ? color.value : (SKIN_COLORS[skin.value] || '#CC785C');
  }
  refreshColorState();

  // Live save on each input change.
  petName.addEventListener('input', () => {
    const v = petName.value.trim().toLowerCase() || 'clawd';
    window.crabAPI.setPref({ petName: v });
  });
  elKey.addEventListener('input', () => {
    window.crabAPI.setPref({ elevenLabsKey: elKey.value.trim() });
  });
  personality.addEventListener('change', () => {
    window.crabAPI.setPref({ personality: personality.value });
  });
  skin.addEventListener('change', () => {
    window.crabAPI.setPref({ skin: skin.value });
    refreshColorState();
  });
  color.addEventListener('input', () => {
    if (skin.value === 'custom') skinSwatch.style.background = color.value;
  });
  speed.addEventListener('input', () => {
    speedVal.textContent = parseFloat(speed.value).toFixed(1);
    window.crabAPI.setPref({ crabSpeed: parseFloat(speed.value) });
  });
  color.addEventListener('input', () => {
    colorVal.textContent = color.value.toUpperCase();
    window.crabAPI.setPref({ crabColor: color.value });
  });
  sleepMin.addEventListener('input', () => {
    sleepMinVal.textContent = sleepMin.value;
    window.crabAPI.setPref({ sleepMinutes: parseInt(sleepMin.value, 10) });
  });
})();
