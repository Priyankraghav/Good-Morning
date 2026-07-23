/* ============================================================
   Prātaḥ Bhajan — App Logic
   ─────────────────────────────────────────────────────────
   Audio player · Media Session · Wake Lock · Streak · Reminders
   ============================================================ */

(function () {
  'use strict';

  // ─── DOM Helpers ────────────────────────────────
  const $ = (id) => document.getElementById(id);

  // ─── DOM References ─────────────────────────────
  const audio          = $('audio');
  const playBtn        = $('play-btn');
  const playIcon       = $('play-icon');
  const pauseIcon      = $('pause-icon');
  const progressTrack  = $('progress-track');
  const progressFill   = $('progress-fill');
  const progressThumb  = $('progress-thumb');
  const elapsedEl      = $('elapsed');
  const remainingEl    = $('remaining');
  const streakBadge    = $('streak-badge');
  const streakCountEl  = $('streak-count');
  const settingsBtn    = $('settings-btn');
  const settingsPanel  = $('settings-panel');
  const settingsBackdrop = $('settings-backdrop');
  const settingsClose  = $('settings-close');
  const streakToggle   = $('streak-toggle');
  const resetStreakBtn  = $('reset-streak-btn');
  const reminderToggle = $('reminder-toggle');
  const reminderTimeRow = $('reminder-time-row');
  const reminderTimeInput = $('reminder-time');
  const reminderNote   = $('reminder-note');
  const resumeOverlay  = $('resume-overlay');
  const resumeBtn      = $('resume-btn');

  // ─── State ──────────────────────────────────────
  let isPlaying         = false;
  let wakeLockSentinel  = null;
  let lastTimeUpdate    = 0;
  let suspendTimer      = null;
  let hasMarkedStreak   = false;
  let reminderTimeout   = null;
  let isSeeking         = false;

  // ─── Constants ──────────────────────────────────
  const STORAGE_STREAK   = 'pratah_streak';
  const STORAGE_SETTINGS = 'pratah_settings';
  const COMPLETION_RATIO = 0.80;  // 80% of duration

  // ─── Default Settings ───────────────────────────
  const DEFAULT_SETTINGS = {
    streakEnabled:   true,
    reminderEnabled: false,
    reminderTime:    '05:30',
  };

  let settings = { ...DEFAULT_SETTINGS };

  // ═══════════════════════════════════════════════════
  //  UTILITY FUNCTIONS
  // ═══════════════════════════════════════════════════

  /** Format seconds → "m:ss" */
  function formatTime(seconds) {
    if (!isFinite(seconds) || seconds < 0) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return m + ':' + String(s).padStart(2, '0');
  }

  /** Today's date as YYYY-MM-DD (local timezone) */
  function todayStr() {
    var d = new Date();
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }

  /** Yesterday's date as YYYY-MM-DD (local timezone) */
  function yesterdayStr() {
    var d = new Date();
    d.setDate(d.getDate() - 1);
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }

  // ═══════════════════════════════════════════════════
  //  AUDIO PLAYER
  // ═══════════════════════════════════════════════════

  function togglePlay() {
    if (audio.paused || audio.ended) {
      audio.play().catch(function () {
        // Autoplay blocked — user gesture needed, which we already have
      });
    } else {
      audio.pause();
    }
  }

  function updatePlayButton() {
    if (isPlaying) {
      playIcon.classList.add('hidden');
      pauseIcon.classList.remove('hidden');
      playBtn.setAttribute('aria-label', 'भजन रोकें');
      playBtn.classList.add('playing');
    } else {
      playIcon.classList.remove('hidden');
      pauseIcon.classList.add('hidden');
      playBtn.setAttribute('aria-label', 'भजन चलाएं');
      playBtn.classList.remove('playing');
    }
  }

  function updateProgress() {
    if (isSeeking) return;
    var dur = audio.duration || 0;
    var cur = audio.currentTime || 0;
    var pct = dur > 0 ? (cur / dur) * 100 : 0;

    progressFill.style.width = pct + '%';
    progressThumb.style.left = pct + '%';
    elapsedEl.textContent = formatTime(cur);
    remainingEl.textContent = '-' + formatTime(dur - cur);
    progressTrack.setAttribute('aria-valuenow', Math.round(pct));
  }

  // ─── Audio Event Listeners ──────────────────────

  audio.addEventListener('play', function () {
    isPlaying = true;
    updatePlayButton();
    acquireWakeLock();
    startSuspendWatch();
    setupMediaSession();

    // Check if new day has arrived — reset session streak marker
    var streak = loadStreak();
    if (streak.lastDate !== todayStr()) {
      hasMarkedStreak = false;
    }
  });

  audio.addEventListener('pause', function () {
    isPlaying = false;
    updatePlayButton();
    releaseWakeLock();
    stopSuspendWatch();
  });

  audio.addEventListener('ended', function () {
    isPlaying = false;
    updatePlayButton();
    releaseWakeLock();
    stopSuspendWatch();
    checkAndRecordStreak();

    // Reset display
    progressFill.style.width = '0%';
    progressThumb.style.left = '0%';
    elapsedEl.textContent = '0:00';
    if (audio.duration && isFinite(audio.duration)) {
      remainingEl.textContent = '-' + formatTime(audio.duration);
    }
  });

  audio.addEventListener('timeupdate', function () {
    lastTimeUpdate = Date.now();
    updateProgress();
    updatePositionState();

    // Check 80% completion for streak
    if (
      !hasMarkedStreak &&
      audio.duration > 0 &&
      audio.currentTime / audio.duration >= COMPLETION_RATIO
    ) {
      hasMarkedStreak = true;
      recordStreakDay();
    }
  });

  audio.addEventListener('loadedmetadata', function () {
    if (audio.duration && isFinite(audio.duration)) {
      remainingEl.textContent = '-' + formatTime(audio.duration);
    }
    updateProgress();
  });

  // If audio resumes on its own, hide the resume prompt
  audio.addEventListener('playing', function () {
    if (!resumeOverlay.classList.contains('hidden')) {
      hideResumePrompt();
    }
  });

  // ─── Seeking via Progress Bar ───────────────────

  function seekFromEvent(clientX) {
    var rect = progressTrack.getBoundingClientRect();
    var pct = (clientX - rect.left) / rect.width;
    pct = Math.max(0, Math.min(1, pct));

    // Update visual immediately
    progressFill.style.width = (pct * 100) + '%';
    progressThumb.style.left = (pct * 100) + '%';

    if (audio.duration && isFinite(audio.duration)) {
      audio.currentTime = pct * audio.duration;
      elapsedEl.textContent = formatTime(audio.currentTime);
      remainingEl.textContent = '-' + formatTime(audio.duration - audio.currentTime);
    }
  }

  // Mouse
  progressTrack.addEventListener('mousedown', function (e) {
    isSeeking = true;
    seekFromEvent(e.clientX);

    function onMove(e2) { seekFromEvent(e2.clientX); }
    function onUp() {
      isSeeking = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  // Touch
  progressTrack.addEventListener('touchstart', function (e) {
    isSeeking = true;
    seekFromEvent(e.touches[0].clientX);
  }, { passive: true });

  progressTrack.addEventListener('touchmove', function (e) {
    if (isSeeking) seekFromEvent(e.touches[0].clientX);
  }, { passive: true });

  progressTrack.addEventListener('touchend', function () {
    isSeeking = false;
  });

  // Keyboard (accessibility)
  progressTrack.addEventListener('keydown', function (e) {
    if (!audio.duration) return;
    var step = audio.duration * 0.02; // 2% per keypress
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
      e.preventDefault();
      audio.currentTime = Math.min(audio.duration, audio.currentTime + step);
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
      e.preventDefault();
      audio.currentTime = Math.max(0, audio.currentTime - step);
    }
  });

  // ═══════════════════════════════════════════════════
  //  MEDIA SESSION API
  //  (Lock screen + notification shade controls)
  // ═══════════════════════════════════════════════════

  function setupMediaSession() {
    if (!('mediaSession' in navigator)) return;

    navigator.mediaSession.metadata = new MediaMetadata({
      title:  'प्रातः भजन',
      artist: 'Morning Bhajan',
      album:  'Prātaḥ Bhajan',
      artwork: [
        { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      ],
    });

    // Register action handlers
    var handlers = {
      play:         function ()  { audio.play(); },
      pause:        function ()  { audio.pause(); },
      stop:         function ()  { audio.pause(); audio.currentTime = 0; },
      seekbackward: function (d) { audio.currentTime = Math.max(0, audio.currentTime - (d.seekOffset || 10)); },
      seekforward:  function (d) { audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + (d.seekOffset || 10)); },
      seekto:       function (d) {
        if (d.fastSeek && 'fastSeek' in audio) {
          audio.fastSeek(d.seekTime);
        } else {
          audio.currentTime = d.seekTime;
        }
        updatePositionState();
      },
    };

    Object.keys(handlers).forEach(function (action) {
      try {
        navigator.mediaSession.setActionHandler(action, handlers[action]);
      } catch (_) {
        // Action not supported on this browser — ignore
      }
    });
  }

  function updatePositionState() {
    if (!('mediaSession' in navigator)) return;
    if (!audio.duration || !isFinite(audio.duration)) return;
    try {
      navigator.mediaSession.setPositionState({
        duration:     audio.duration,
        playbackRate: audio.playbackRate,
        position:     Math.min(audio.currentTime, audio.duration),
      });
    } catch (_) { /* ignore */ }
  }

  // ═══════════════════════════════════════════════════
  //  WAKE LOCK API
  //  (Keep screen on during playback)
  // ═══════════════════════════════════════════════════

  async function acquireWakeLock() {
    if (!('wakeLock' in navigator)) return;
    try {
      wakeLockSentinel = await navigator.wakeLock.request('screen');
      wakeLockSentinel.addEventListener('release', function () {
        wakeLockSentinel = null;
      });
    } catch (_) {
      // Best effort — may fail if page is hidden
    }
  }

  function releaseWakeLock() {
    if (wakeLockSentinel) {
      wakeLockSentinel.release().catch(function () {});
      wakeLockSentinel = null;
    }
  }

  // Re-acquire wake lock when returning to the app
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && isPlaying && !wakeLockSentinel) {
      acquireWakeLock();
    }
  });

  // ═══════════════════════════════════════════════════
  //  BACKGROUND SUSPEND DETECTION
  //  (Show resume prompt if audio unexpectedly stops)
  // ═══════════════════════════════════════════════════

  function startSuspendWatch() {
    lastTimeUpdate = Date.now();
    stopSuspendWatch();
    suspendTimer = setInterval(function () {
      // If we think we're playing but timeupdate hasn't fired in 3s
      if (isPlaying && Date.now() - lastTimeUpdate > 3000) {
        // Check if audio is actually paused (suspended by OS)
        if (audio.paused) {
          isPlaying = false;
          updatePlayButton();
          showResumePrompt();
        }
      }
    }, 2000);
  }

  function stopSuspendWatch() {
    if (suspendTimer) {
      clearInterval(suspendTimer);
      suspendTimer = null;
    }
  }

  function showResumePrompt() {
    resumeOverlay.classList.remove('hidden');
    resumeOverlay.setAttribute('aria-hidden', 'false');
  }

  function hideResumePrompt() {
    resumeOverlay.classList.add('hidden');
    resumeOverlay.setAttribute('aria-hidden', 'true');
  }

  resumeBtn.addEventListener('click', function () {
    hideResumePrompt();
    audio.play().catch(function () {});
  });

  // ═══════════════════════════════════════════════════
  //  STREAK TRACKING
  //  (Daily streak counter stored in localStorage)
  // ═══════════════════════════════════════════════════

  function loadStreak() {
    try {
      var raw = localStorage.getItem(STORAGE_STREAK);
      if (raw) return JSON.parse(raw);
    } catch (_) {}
    return { count: 0, lastDate: '' };
  }

  function saveStreak(data) {
    try {
      localStorage.setItem(STORAGE_STREAK, JSON.stringify(data));
    } catch (_) {}
  }

  /** Record today as a streak day (called when 80% is reached) */
  function recordStreakDay() {
    if (!settings.streakEnabled) return;

    var streak = loadStreak();
    var today = todayStr();

    // Already recorded today
    if (streak.lastDate === today) return;

    if (streak.lastDate === yesterdayStr()) {
      // Consecutive — increment
      streak.count += 1;
    } else {
      // First day or streak broken — start fresh
      streak.count = 1;
    }

    streak.lastDate = today;
    saveStreak(streak);
    displayStreak();
  }

  /** Called on audio 'ended' as a fallback check */
  function checkAndRecordStreak() {
    if (hasMarkedStreak) return;
    if (audio.duration > 0 && audio.currentTime / audio.duration >= COMPLETION_RATIO) {
      hasMarkedStreak = true;
      recordStreakDay();
    }
  }

  /** Update the streak badge in the UI */
  function displayStreak() {
    if (!settings.streakEnabled) {
      streakBadge.classList.add('hidden');
      return;
    }

    var streak = loadStreak();

    // Check if streak has been broken (more than 1 day gap)
    if (
      streak.count > 0 &&
      streak.lastDate !== todayStr() &&
      streak.lastDate !== yesterdayStr()
    ) {
      streak.count = 0;
      streak.lastDate = '';
      saveStreak(streak);
    }

    if (streak.count > 0) {
      streakCountEl.textContent = streak.count;
      streakBadge.classList.remove('hidden');
    } else {
      streakBadge.classList.add('hidden');
    }
  }

  function resetStreak() {
    saveStreak({ count: 0, lastDate: '' });
    hasMarkedStreak = false;
    displayStreak();
  }

  // ═══════════════════════════════════════════════════
  //  NOTIFICATION REMINDERS
  //  (Local notifications — no backend required)
  // ═══════════════════════════════════════════════════

  /** Request notification permission from user with timeout protection */
  async function requestNotificationPermission() {
    if (!('Notification' in window)) return false;
    if (Notification.permission === 'granted') return true;
    if (Notification.permission === 'denied') return false;
    try {
      var permPromise = Notification.requestPermission();
      var timeoutPromise = new Promise(function (resolve) {
        setTimeout(function () { resolve('denied'); }, 2000);
      });
      var result = await Promise.race([permPromise, timeoutPromise]);
      return result === 'granted';
    } catch (_) {
      return false;
    }
  }

  /** Schedule the next reminder at the configured time */
  function scheduleReminder() {
    clearReminder();
    if (!settings.reminderEnabled) return;

    var parts = settings.reminderTime.split(':');
    var hours = parseInt(parts[0], 10);
    var minutes = parseInt(parts[1], 10);

    var now = new Date();
    var target = new Date();
    target.setHours(hours, minutes, 0, 0);

    // If target time already passed today, schedule for tomorrow
    if (target <= now) {
      target.setDate(target.getDate() + 1);
    }

    var ms = target.getTime() - now.getTime();

    reminderTimeout = setTimeout(function () {
      fireReminder();
      // Schedule next day's reminder
      scheduleReminder();
    }, ms);
  }

  function clearReminder() {
    if (reminderTimeout) {
      clearTimeout(reminderTimeout);
      reminderTimeout = null;
    }
  }

  /** Fire the actual notification */
  async function fireReminder() {
    var hasPermission = await requestNotificationPermission();
    if (!hasPermission) return;

    // Prefer service worker notification (better for installed PWAs)
    if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
      try {
        var reg = await navigator.serviceWorker.ready;
        await reg.showNotification('प्रातः भजन 🙏', {
          body:  'भजन का समय हो गया 🙏',
          icon:  'icons/icon-192.png',
          badge: 'icons/icon-192.png',
          tag:   'pratah-reminder',
          renotify: true,
          requireInteraction: false,
          data: { url: './index.html' },
        });
        return;
      } catch (_) { /* fall through to basic notification */ }
    }

    // Fallback: basic Notification constructor
    try {
      new Notification('प्रातः भजन 🙏', {
        body: 'भजन का समय हो गया 🙏',
        icon: 'icons/icon-192.png',
        tag:  'pratah-reminder',
      });
    } catch (_) {}
  }

  // ═══════════════════════════════════════════════════
  //  SETTINGS (persisted in localStorage)
  // ═══════════════════════════════════════════════════

  function loadSettings() {
    try {
      var raw = localStorage.getItem(STORAGE_SETTINGS);
      if (raw) {
        var saved = JSON.parse(raw);
        settings = Object.assign({}, DEFAULT_SETTINGS, saved);
      }
    } catch (_) {}
  }

  function saveSettings() {
    try {
      localStorage.setItem(STORAGE_SETTINGS, JSON.stringify(settings));
    } catch (_) {}
  }

  /** Sync the settings panel UI with current settings state */
  function applySettingsToUI() {
    streakToggle.checked   = settings.streakEnabled;
    reminderToggle.checked = settings.reminderEnabled;
    reminderTimeInput.value = settings.reminderTime;

    if (settings.reminderEnabled) {
      reminderTimeRow.classList.remove('hidden');
      reminderNote.classList.remove('hidden');
    } else {
      reminderTimeRow.classList.add('hidden');
      reminderNote.classList.add('hidden');
    }
  }

  function openSettings() {
    applySettingsToUI();
    settingsPanel.classList.remove('hidden');
    settingsBackdrop.classList.remove('hidden');
    settingsPanel.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
  }

  function closeSettings() {
    settingsPanel.classList.add('hidden');
    settingsBackdrop.classList.add('hidden');
    settingsPanel.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
  }

  // ─── Settings Event Listeners ───────────────────

  settingsBtn.addEventListener('click', openSettings);
  settingsClose.addEventListener('click', closeSettings);
  settingsBackdrop.addEventListener('click', closeSettings);

  // Close settings on Escape key
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !settingsPanel.classList.contains('hidden')) {
      closeSettings();
    }
  });

  streakToggle.addEventListener('change', function () {
    settings.streakEnabled = streakToggle.checked;
    saveSettings();
    displayStreak();
  });

  resetStreakBtn.addEventListener('click', function () {
    if (confirm('क्या आप सच में स्ट्रीक रीसेट करना चाहते हैं?')) {
      resetStreak();
    }
  });

  reminderToggle.addEventListener('change', async function () {
    if (reminderToggle.checked) {
      var granted = await requestNotificationPermission();
      if (!granted) {
        reminderToggle.checked = false;
        alert('Notification permission denied.\nकृपया browser/app settings में notifications allow करें।');
        return;
      }
    }

    settings.reminderEnabled = reminderToggle.checked;
    saveSettings();
    applySettingsToUI();

    if (settings.reminderEnabled) {
      scheduleReminder();
    } else {
      clearReminder();
    }
  });

  reminderTimeInput.addEventListener('change', function () {
    settings.reminderTime = reminderTimeInput.value;
    saveSettings();
    if (settings.reminderEnabled) {
      scheduleReminder(); // Reschedule with new time
    }
  });

  // ═══════════════════════════════════════════════════
  //  PLAY BUTTON + KEYBOARD SHORTCUT
  // ═══════════════════════════════════════════════════

  playBtn.addEventListener('click', togglePlay);

  // Spacebar to toggle play/pause (only when not in an input)
  document.addEventListener('keydown', function (e) {
    if (e.code === 'Space' && e.target === document.body) {
      e.preventDefault();
      togglePlay();
    }
  });

  // ═══════════════════════════════════════════════════
  //  SERVICE WORKER REGISTRATION
  // ═══════════════════════════════════════════════════

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('./service-worker.js')
        .then(function (reg) {
          // Check for updates every hour
          setInterval(function () { reg.update(); }, 60 * 60 * 1000);
        })
        .catch(function (err) {
          console.warn('SW registration failed:', err);
        });
    });
  }

  // ═══════════════════════════════════════════════════
  //  INITIALIZATION
  // ═══════════════════════════════════════════════════

  function init() {
    loadSettings();
    displayStreak();
    updatePlayButton();
    applySettingsToUI();

    // Schedule reminder if it's enabled
    if (settings.reminderEnabled) {
      scheduleReminder();
    }

    // Set initial duration once metadata is available
    if (audio.duration && isFinite(audio.duration)) {
      remainingEl.textContent = '-' + formatTime(audio.duration);
    }
  }

  init();

})();
