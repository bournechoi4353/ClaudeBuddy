(async function init() {
  const prefs = (await window.crabAPI.getPrefs()) || {};

  const $ = (id) => document.getElementById(id);
  const petName = $('petName');
  const personality = $('personality');
  const skin = $('skin');
  const speed = $('speed');
  const speedVal = $('speedVal');
  const color = $('color');
  const colorVal = $('colorVal');
  const sleepMin = $('sleepMin');
  const sleepMinVal = $('sleepMinVal');

  petName.value = prefs.petName || 'drizzle';
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
    const v = petName.value.trim().toLowerCase() || 'drizzle';
    window.crabAPI.setPref({ petName: v });
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

  // Skin and crab color only apply to the crab, so they are hidden while the raincloud is the pet.
  const showCrabSettings = (show) => {
    document.querySelectorAll('.crab-only').forEach((el) => { el.hidden = !show; });
  };
  showCrabSettings(!(prefs.petBrainAvailable && prefs.petBrainEnabled !== false));

  // Pet brain section: main reports petBrainAvailable unless PET_BRAIN_LOCAL=0 closed the gate,
  // so with the gate closed this section never appears and the crab settings stay.
  if (prefs.petBrainAvailable) {
    $('petBrainSection').hidden = false;
    const petOn = $('petBrainOn');
    const petChattiness = $('petChattiness');
    petOn.checked = prefs.petBrainEnabled !== false;
    petChattiness.value = prefs.petChattiness || 'normal';
    petOn.addEventListener('change', () => {
      window.crabAPI.setPref({ petBrainEnabled: petOn.checked });
      showCrabSettings(!petOn.checked);
    });
    petChattiness.addEventListener('change', () => {
      window.crabAPI.setPref({ petChattiness: petChattiness.value });
    });

    // Reduce animation: shows the system's setting until the user picks a side, then keeps their choice.
    const petReduce = $('petReduce');
    const systemReduces = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    petReduce.checked = typeof prefs.petReduceMotion === 'boolean' ? prefs.petReduceMotion : systemReduces;
    petReduce.addEventListener('change', () => {
      window.crabAPI.setPref({ petReduceMotion: petReduce.checked });
    });

    // Smart lines: local model, off by default. The status line comes from the main process.
    const smart = $('petSmart');
    const modelPath = $('petModelPath');
    const modelStatus = $('petModelStatus');
    smart.value = prefs.petSmartLines === true ? 'on' : 'off';
    modelPath.value = prefs.petModelPath || '';
    async function refreshModelStatus() {
      try {
        const status = await window.crabAPI.getModelStatus();
        modelStatus.textContent = status ? status.line : '';
      } catch (_) { /* window closing */ }
    }
    smart.addEventListener('change', () => {
      window.crabAPI.setPref({ petSmartLines: smart.value === 'on' });
      setTimeout(refreshModelStatus, 200);
    });
    modelPath.addEventListener('change', () => {
      window.crabAPI.setPref({ petModelPath: modelPath.value.trim() });
      setTimeout(refreshModelStatus, 200);
    });
    $('petModelBrowse').addEventListener('click', async () => {
      const chosen = await window.crabAPI.pickModelFile();
      if (!chosen) return;
      modelPath.value = chosen;
      window.crabAPI.setPref({ petModelPath: chosen });
      setTimeout(refreshModelStatus, 200);
    });
    refreshModelStatus();
    setInterval(refreshModelStatus, 2000);

    // Weather mood (opt-in). The place is stored on this machine in prefs.json.
    const weatherOn = $('petWeatherOn');
    const weatherBox = $('petWeatherBox');
    const city = $('petCity');
    const places = $('petPlaces');
    const placeNote = $('petPlaceNote');
    function showPlaceNote() {
      const place = prefs.petWeatherPlace;
      placeNote.textContent = place && place.label ? 'Using ' + place.label : 'No place chosen yet.';
    }
    weatherOn.checked = prefs.petWeatherEnabled === true;
    weatherBox.hidden = !weatherOn.checked;
    showPlaceNote();
    weatherOn.addEventListener('change', () => {
      weatherBox.hidden = !weatherOn.checked;
      window.crabAPI.setPref({ petWeatherEnabled: weatherOn.checked });
    });
    $('petFind').addEventListener('click', async () => {
      placeNote.textContent = 'Looking up...';
      places.hidden = true;
      const reply = await window.crabAPI.findPlaces(city.value);
      if (!reply || reply.error) {
        placeNote.textContent = (reply && reply.error) || 'Lookup failed.';
        return;
      }
      if (!reply.results.length) {
        placeNote.textContent = 'No match. Try a nearby larger city.';
        return;
      }
      places.innerHTML = '';
      reply.results.forEach((r, i) => {
        const opt = document.createElement('option');
        opt.value = String(i);
        opt.textContent = r.label;
        places.appendChild(opt);
      });
      const choose = () => {
        const r = reply.results[parseInt(places.value, 10)];
        prefs.petWeatherPlace = { label: r.label, latitude: r.latitude, longitude: r.longitude };
        window.crabAPI.setPref({ petWeatherPlace: prefs.petWeatherPlace });
        showPlaceNote();
      };
      places.onchange = choose;
      places.hidden = false;
      choose();
    });

    $('petResetLines').addEventListener('click', () => {
      window.crabAPI.resetPetLines();
      const note = $('petResetNote');
      note.textContent = 'Line history cleared.';
      setTimeout(() => { note.textContent = ''; }, 2500);
    });
  }
})();
