(function() {
    const root = document.getElementById('app');
    const bootstrap = window.__BOOTSTRAP__ || {};
    let user = bootstrap.user;
    let config = bootstrap.config || {};
    const externalFrontend = Boolean(window.__US_GITHUB_FRONTEND__);
    window.OneSignalDeferred = window.OneSignalDeferred || [];
    const state = {
      activeTab: 'today',
      today: null,
      loading: true,
      error: '',
      feed: {
        items: [],
        nextCursor: null,
        hasMore: false,
        loading: false,
        loadingMore: false,
        loaded: false
      },
      composer: {
        open: false,
        mode: 'text',
        photoBase64: '',
        photoMimeType: '',
        photoPreview: '',
        songUrl: '',
        voiceBase64: '',
        voiceMimeType: '',
        voicePreview: '',
        recording: false,
        recorder: null,
        voiceChunks: []
      },
      us: {
        subtab: 'bucket',
        bucket: { open: [], done: [], loaded: false, loading: false, showDone: false },
        reunions: { next: null, upcoming: [], past: [], loaded: false, loading: false, showPast: false },
        editingReunionId: ''
      },
      memories: {
        memory: null,
        capsules: { unlocked: [], locked: [], loaded: false, loading: false },
        loading: false,
        loaded: false,
        message: ''
      },
      ui: {
        showNotificationBanner: false,
        showInstallTip: false,
        revealAnswers: false
      }
    };

    let serviceWorkerReadyPromise = Promise.resolve(null);

    function init() {
      document.documentElement.style.setProperty('--accent', config.accent_color || '#E07856');
      setupMobileViewport();
      if (externalFrontend && !user) {
        initExternalFrontend();
        return;
      }

      if (!user) {
        renderUnauthorized();
        return;
      }
      startAuthenticatedApp();
    }

    function startAuthenticatedApp() {
      setupSplash();
      setupInlinePrompts();
      setupGlobalTapFallbacks();
      setupOneSignal();
      render();
      loadToday();
      window.addEventListener('scroll', maybeLoadMoreFeed, { passive: true });
      window.addEventListener('resize', setupMobileViewport, { passive: true });
    }

    function initExternalFrontend() {
      setupGlobalTapFallbacks();
      renderExternalLogin();
      const token = getExternalToken();
      if (!token) return;

      apiGet('getMe')
        .then(function(result) {
          if (!result.ok) throw new Error(result.error || 'unauthorized');
          user = result.data.user;
          config = Object.assign({}, config, result.data.config || {});
          document.documentElement.style.setProperty('--accent', config.accent_color || '#E07856');
          startAuthenticatedApp();
        })
        .catch(function(err) {
          localStorage.removeItem('us_frontend_token');
          renderExternalLogin(humanError(err.message));
        });
    }

    function setupMobileViewport() {
      const viewportWidth = Math.max(320, window.innerWidth || document.documentElement.clientWidth || 390);
      const physicalWidth = Math.max(320, window.screen && window.screen.width || viewportWidth);
      const scale = Math.max(1, Math.min(2.6, viewportWidth / Math.min(430, physicalWidth)));
      document.documentElement.style.setProperty('--app-mobile-scale', scale.toFixed(3));
      document.documentElement.style.setProperty('--app-layout-width', (viewportWidth / scale).toFixed(2) + 'px');
    }

    function setupSplash() {
      const splash = document.getElementById('splash');
      if (!splash) return;
      const firstVisit = localStorage.getItem('us_splash_seen') !== 'true';
      const duration = firstVisit ? 2500 : 1500;
      splash.style.setProperty('--splash-duration', duration + 'ms');
      window.setTimeout(function() {
        splash.remove();
        localStorage.setItem('us_splash_seen', 'true');
      }, duration + 100);
    }

    function setupInlinePrompts() {
      const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
      const dismissedInstall = localStorage.getItem('us_install_tip_dismissed') === 'true';
      const dismissedNotifs = localStorage.getItem('us_notifications_dismissed') === 'true';
      state.ui.showInstallTip = isIosSafari() && !standalone && !dismissedInstall;
      state.ui.showNotificationBanner = !dismissedNotifs && 'Notification' in window && Notification.permission === 'default';
    }

    function loadToday() {
      state.loading = true;
      render();
      apiGet('getToday')
        .then(function(result) {
          if (!result.ok) throw new Error(result.error || 'Failed to load today');
          if (state.today && state.today.date !== result.data.date) {
            state.ui.revealAnswers = false;
          }
          state.today = result.data;
          state.error = '';
        })
        .catch(function(err) {
          state.error = humanError(err.message);
        })
        .finally(function() {
          state.loading = false;
          render();
        });
    }

    function loadFeed(reset) {
      if (state.feed.loading || state.feed.loadingMore) return Promise.resolve();
      if (reset) {
        state.feed.loading = true;
        state.feed.nextCursor = null;
        state.feed.hasMore = false;
      } else {
        state.feed.loadingMore = true;
      }
      render();

      return apiGet('getFeed', {
        before: reset ? '' : state.feed.nextCursor,
        limit: 20
      })
        .then(function(result) {
          if (!result.ok) throw new Error(result.error || 'Feed failed');
          const data = result.data || {};
          state.feed.items = reset ? data.items || [] : state.feed.items.concat(data.items || []);
          state.feed.nextCursor = data.nextCursor || null;
          state.feed.hasMore = Boolean(data.hasMore);
          state.feed.loaded = true;
          state.error = '';
        })
        .catch(function(err) {
          state.error = humanError(err.message);
        })
        .finally(function() {
          state.feed.loading = false;
          state.feed.loadingMore = false;
          render();
        });
    }

    function loadUs() {
      return Promise.all([loadBucket(), loadReunions()]);
    }

    function loadBucket() {
      if (state.us.bucket.loading) return Promise.resolve();
      state.us.bucket.loading = true;
      render();

      return apiGet('getBucket')
        .then(function(result) {
          if (!result.ok) throw new Error(result.error || 'Bucket failed');
          state.us.bucket.open = result.data.open || [];
          state.us.bucket.done = result.data.done || [];
          state.us.bucket.loaded = true;
          state.error = '';
        })
        .catch(function(err) {
          state.error = humanError(err.message);
        })
        .finally(function() {
          state.us.bucket.loading = false;
          render();
        });
    }

    function loadReunions() {
      if (state.us.reunions.loading) return Promise.resolve();
      state.us.reunions.loading = true;
      render();

      return apiGet('getReunions')
        .then(function(result) {
          if (!result.ok) throw new Error(result.error || 'Reunions failed');
          state.us.reunions.next = result.data.next || null;
          state.us.reunions.upcoming = result.data.upcoming || [];
          state.us.reunions.past = result.data.past || [];
          state.us.reunions.loaded = true;
          state.error = '';
        })
        .catch(function(err) {
          state.error = humanError(err.message);
        })
        .finally(function() {
          state.us.reunions.loading = false;
          render();
        });
    }

    function loadMemory() {
      if (state.memories.loading) return Promise.resolve();
      state.memories.loading = true;
      render();

      return Promise.all([apiGet('getMemory'), loadCapsules()])
        .then(function(results) {
          const result = results[0];
          if (!result.ok) throw new Error(result.error || 'Memory failed');
          state.memories.memory = result.data.memory || null;
          state.memories.message = result.data.message || '';
          state.memories.loaded = true;
          state.error = '';
        })
        .catch(function(err) {
          state.error = humanError(err.message);
        })
        .finally(function() {
          state.memories.loading = false;
          render();
        });
    }

    function loadCapsules() {
      if (state.memories.capsules.loading) return Promise.resolve();
      state.memories.capsules.loading = true;
      return apiGet('getCapsules')
        .then(function(result) {
          if (!result.ok) throw new Error(result.error || 'Capsules failed');
          state.memories.capsules.unlocked = result.data.unlocked || [];
          state.memories.capsules.locked = result.data.locked || [];
          state.memories.capsules.loaded = true;
          state.error = '';
        })
        .catch(function(err) {
          state.error = humanError(err.message);
        })
        .finally(function() {
          state.memories.capsules.loading = false;
          render();
        });
    }

    function maybeLoadMoreFeed() {
      if (state.activeTab !== 'feed' || !state.feed.hasMore || state.feed.loadingMore || state.feed.loading) return;
      const remaining = document.documentElement.scrollHeight - window.innerHeight - window.scrollY;
      if (remaining < 400) loadFeed(false);
    }

    function renderUnauthorized() {
      root.innerHTML = [
        '<section class="phase-card">',
        '<p class="eyebrow">Not authorized</p>',
        '<h1>Us</h1>',
        '<p>This private app is only available to the two configured Google accounts.</p>',
        '<div class="meta"><span>Sign in with the correct Google account, then reload this page.</span></div>',
        '</section>'
      ].join('');
    }

    function renderExternalLogin(message) {
      root.innerHTML = [
        '<section class="phone-shell external-login">',
        '<header class="app-header"><span class="app-mark">R&amp;M</span><strong>Us</strong></header>',
        '<section class="card">',
        '<p class="eyebrow">Private access</p>',
        '<h2>Open Us</h2>',
        '<p>Paste your personal frontend token once. It stays on this device.</p>',
        message ? '<p class="form-error">' + escapeHtml(message) + '</p>' : '',
        '<input id="frontend-token" class="text-input" type="password" autocomplete="off" placeholder="Frontend token">',
        '<button type="button" class="primary wide" data-action="save-frontend-token">Continue</button>',
        '</section>',
        '</section>'
      ].join('');

      const input = document.getElementById('frontend-token');
      const button = root.querySelector('[data-action="save-frontend-token"]');
      if (button) {
        button.addEventListener('click', function() {
          const token = input ? input.value.trim() : '';
          if (!token) return showToast('Paste your frontend token first.');
          localStorage.setItem('us_frontend_token', token);
          initExternalFrontend();
        });
      }
    }

    function render() {
      root.innerHTML = [
        '<section class="phone-shell">',
        '<header class="app-header"><span class="app-mark">R&amp;M</span><strong>Us</strong></header>',
        renderClockStrip(),
        '<div class="screen">',
        renderActiveTab(),
        '</div>',
        renderTabs(),
        state.activeTab === 'feed' ? '<button class="fab" data-action="open-composer" aria-label="Create post">+</button>' : '',
        '</section>',
        state.composer.open ? renderComposer() : '',
        state.error ? '<div class="toast">' + escapeHtml(state.error) + '</div>' : ''
      ].join('');
      bindEvents();
    }

    function renderActiveTab() {
      if (state.activeTab === 'today') return renderToday();
      if (state.activeTab === 'feed') return renderFeed();
      if (state.activeTab === 'us') return renderUs();
      if (state.activeTab === 'memories') return renderMemories();
      return renderPlaceholderTab();
    }

    function renderClockStrip() {
      const clocks = state.today && state.today.clocks ? state.today.clocks : [
        { name: config.user_a_name || 'Max', time: '--:--' },
        { name: config.user_b_name || 'Rui', time: '--:--' }
      ];
      return '<div class="clock-strip">' + clocks.map(function(clock) {
        const weather = clock.weather ? ' · ' + clock.weather.temperatureC + '°C ' + clock.weather.summary : '';
        return '<span>' + escapeHtml(clock.name) + ' ' + escapeHtml(clock.time + weather) + '</span>';
      }).join('<span class="dot">.</span>') + '</div>';
    }

    function renderToday() {
      if (state.loading && !state.today) {
        return [
          '<div class="hero-skeleton"></div>',
          '<div class="card skeleton-card"></div>',
          '<div class="button-row"><div class="button-skeleton"></div><div class="button-skeleton"></div></div>'
        ].join('');
      }

      const today = state.today;
      if (!today) {
        return '<div class="card"><h2>Today</h2><p>Could not load today yet.</p><button class="primary" data-action="reload">Try again</button></div>';
      }

      return [
        renderCountdown(today.nextReunion),
        renderRelationshipStats(today),
        renderNotificationBanner(today),
        renderQuestionCard(today),
        renderDailyPhoto(today.dailyPhoto),
        renderStatusButtons(today),
        renderInstallTip()
      ].join('');
    }

    function renderNotificationBanner(today) {
      if (!state.ui.showNotificationBanner) return '';
      const partner = today && today.otherUser ? today.otherUser.name : 'Rui';
      return [
        '<section class="inline-banner notification-banner">',
        '<div class="notification-copy">',
        '<strong>Notifications</strong>',
        '<p>Get notified when ' + escapeHtml(partner) + ' posts.</p>',
        '</div>',
        '<div class="notification-actions">',
        '<button type="button" class="mini-action notification-enable" data-action="enable-notifications">Enable notifications</button>',
        '<button type="button" class="mini-action muted" data-action="dismiss-notifications">Not now</button>',
        '</div>',
        '</section>'
      ].join('');
    }

    function renderInstallTip() {
      if (!state.ui.showInstallTip) return '';
      return [
        '<section class="install-tip">',
        '<p>Tap Share → Add to Home Screen to install Us as an app.</p>',
        '<button class="text-action" data-action="dismiss-install-tip">dismiss</button>',
        '</section>'
      ].join('');
    }

    function renderCountdown(nextReunion) {
      if (!nextReunion) {
        return [
          '<section class="today-hero">',
          '<span class="hero-number">-</span>',
          '<span class="hero-label">next reunion not set yet</span>',
          '</section>'
        ].join('');
      }
      return [
        '<section class="today-hero">',
        '<span class="hero-number">' + escapeHtml(nextReunion.daysUntil == null ? '-' : nextReunion.daysUntil) + '</span>',
        '<span class="hero-label">days until ' + escapeHtml(nextReunion.location || nextReunion.title || 'next reunion') + '</span>',
        '</section>'
      ].join('');
    }

    function renderQuestionCard(today) {
      const question = today.question || {};
      const disabled = today.answered.me || question.locked;
      const answerCopy = today.answered.other ? today.otherUser.name + ' already answered' : today.otherUser.name + ' has not answered yet';
      const textarea = today.answered.me
        ? '<p class="answered-note">You answered today.</p>'
        : '<textarea id="answer" rows="5" placeholder="Write your answer..." ' + (disabled ? 'disabled' : '') + '></textarea>';
      const button = today.answered.me
        ? ''
        : '<button class="primary" data-action="submit-answer" ' + (disabled ? 'disabled' : '') + '>Submit</button>';

      const answers = today.answers && state.ui.revealAnswers ? renderAnswers(today.answers) : '';
      const revealPrompt = today.answers && !state.ui.revealAnswers
        ? '<button class="secondary wide" data-action="reveal-answers">Both done. Tap to reveal.</button>'
        : '';

      return [
        '<section class="card question-card">',
        '<div class="card-heading">',
        "<span>Today's question</span>",
        '<small>' + escapeHtml(question.category || '') + '</small>',
        '</div>',
        '<h2>' + escapeHtml(question.text || '') + '</h2>',
        textarea,
        button,
        '<p class="hint">' + escapeHtml(answerCopy) + '</p>',
        revealPrompt,
        answers,
        '</section>'
      ].join('');
    }

    function renderRelationshipStats(today) {
      const stats = today.relationshipStats;
      if (!stats) return '';
      const milestone = stats.nextMilestone
        ? '<span>' + escapeHtml(stats.nextMilestone.label) + ' in ' + escapeHtml(stats.nextMilestone.daysUntil) + ' days</span>'
        : '';
      return [
        '<section class="stats-strip">',
        '<span><strong>' + escapeHtml(stats.daysTogether == null ? '-' : stats.daysTogether) + '</strong> days together</span>',
        '<span><strong>' + escapeHtml(today.answerStreak || 0) + '</strong> answer streak</span>',
        milestone,
        '<button class="mini-action" data-action="thinking-of-you">Thinking of you</button>',
        '</section>'
      ].join('');
    }

    function renderDailyPhoto(dailyPhoto) {
      if (!dailyPhoto) return '';
      const photos = dailyPhoto.photos || [];
      const reveal = photos.length >= 2;
      return [
        '<section class="card daily-photo-card">',
        '<div class="card-heading"><span>Daily photo</span><small>' + escapeHtml(dailyPhoto.date || '') + '</small></div>',
        reveal ? '<div class="daily-photo-grid">' + photos.map(function(photo) {
          return [
            '<figure>',
            '<img src="' + escapeHtml(photo.mediaUrl) + '" alt="' + escapeHtml(photo.name) + ' daily photo" loading="lazy">',
            '<figcaption>' + escapeHtml(photo.name) + '</figcaption>',
            '</figure>'
          ].join('');
        }).join('') + '</div>' : '<p class="hint">' + (dailyPhoto.meSubmitted ? 'Your photo is in. Waiting for the other one.' : "Add today's quick photo. It reveals when both are in.") + '</p>',
        '<input id="daily-photo-input" type="file" accept="image/*" capture="environment">',
        '<button class="secondary wide" data-action="submit-daily-photo">' + (dailyPhoto.meSubmitted ? "Replace today's photo" : "Add today's photo") + '</button>',
        '</section>'
      ].join('');
    }

    function renderAnswers(answers) {
      return [
        '<div class="answers">',
        answers.map(function(answer) {
          return [
            '<article class="answer">',
            '<strong>' + escapeHtml(answer.name) + '</strong>',
            '<p>' + escapeHtml(answer.answer) + '</p>',
            '</article>'
          ].join('');
        }).join(''),
        '</div>'
      ].join('');
    }

    function renderStatusButtons(today) {
      const latest = latestStatusText(today.status || []);
      return [
        '<section class="status-panel">',
        '<div class="button-row">',
        '<button class="secondary" data-action="status" data-type="morning">Good morning</button>',
        '<button class="secondary" data-action="status" data-type="night">Good night</button>',
        '</div>',
        latest ? '<p class="hint">' + escapeHtml(latest) + '</p>' : '<p class="hint">No status shared today yet.</p>',
        '</section>'
      ].join('');
    }

    function renderFeed() {
      if (state.feed.loading && !state.feed.loaded) {
        return '<section class="feed-list"><div class="card skeleton-card"></div><div class="card skeleton-card"></div></section>';
      }

      if (!state.feed.items.length) {
        return [
          '<section class="empty-feed">',
          '<h2>Feed</h2>',
          '<p>Nothing here yet. You go first.</p>',
          '<button class="primary" data-action="open-composer">Create first post</button>',
          '</section>'
        ].join('');
      }

      return [
        '<section class="feed-list">',
        state.feed.items.map(renderFeedPost).join(''),
        state.feed.loadingMore ? '<p class="hint feed-loading">Loading more...</p>' : '',
        !state.feed.hasMore ? '<p class="hint feed-loading">You are caught up.</p>' : '',
        '</section>'
      ].join('');
    }

    function renderFeedPost(post) {
      return [
        '<article class="feed-post" data-post-id="' + escapeHtml(post.id) + '">',
        '<header class="post-header">',
        '<span class="avatar">' + escapeHtml(post.authorInitial || '?') + '</span>',
        '<div><strong>' + escapeHtml(post.authorName) + '</strong><p>' + escapeHtml(relativeTime(post.createdAt)) + '</p></div>',
        '</header>',
        renderPostContent(post),
        '<footer class="post-actions">',
        post.canHeart ? '<button class="icon-action' + (post.heartedByOther ? ' hearted' : '') + '" data-action="heart-post" data-post-id="' + escapeHtml(post.id) + '" aria-label="Heart post">' + (post.heartedByOther ? '♥' : '♡') + '</button>' : '<span class="heart-state">' + (post.heartedByOther ? '♥ hearted' : '') + '</span>',
        post.canDelete ? '<button class="text-action" data-action="delete-post" data-post-id="' + escapeHtml(post.id) + '">delete</button>' : '',
        '</footer>',
        '</article>'
      ].join('');
    }

    function renderPostContent(post) {
      if (post.type === 'photo') {
        return [
          post.text ? '<p class="post-text">' + escapeHtml(post.text) + '</p>' : '',
          '<img class="post-photo" src="' + escapeHtml(post.mediaUrl) + '" alt="Shared photo" loading="lazy" data-drive-id="' + escapeHtml(post.mediaDriveId || '') + '">'
        ].join('');
      }

      if (post.type === 'song') {
        return [
          post.text ? '<p class="post-text">' + escapeHtml(post.text) + '</p>' : '',
          renderSongEmbed(post.songUrl, post.songEmbedUrl, post.songPlatform)
        ].join('');
      }

      if (post.type === 'voice') {
        return [
          post.text ? '<p class="post-text">' + escapeHtml(post.text) + '</p>' : '',
          '<audio class="voice-player" controls src="' + escapeHtml(post.mediaUrl) + '"></audio>'
        ].join('');
      }

      return '<p class="post-text">' + escapeHtml(post.text) + '</p>';
    }

    function renderSongEmbed(songUrl, embedUrl, platform) {
      if (!embedUrl) {
        return '<a class="song-link" href="' + escapeHtml(songUrl) + '" target="_blank" rel="noopener">Open song link</a>';
      }

      if (platform === 'youtube') {
        return '<iframe class="song-embed youtube" src="' + escapeHtml(embedUrl) + '" loading="lazy" allowfullscreen></iframe>';
      }

      return '<iframe class="song-embed" src="' + escapeHtml(embedUrl) + '" loading="lazy" allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"></iframe>';
    }

    function renderComposer() {
      const mode = state.composer.mode;
      return [
        '<div class="sheet-backdrop" data-action="close-composer"></div>',
        '<section class="bottom-sheet" role="dialog" aria-modal="true">',
        '<div class="sheet-handle"></div>',
        '<div class="composer-tabs">',
        ['text', 'photo', 'voice', 'song'].map(function(tab) {
          return '<button class="composer-tab' + (mode === tab ? ' active' : '') + '" data-composer-mode="' + tab + '">' + titleCase(tab) + '</button>';
        }).join(''),
        '</div>',
        renderComposerBody(mode),
        '</section>'
      ].join('');
    }

    function renderComposerBody(mode) {
      const postButton = '<button class="primary wide" data-action="publish-post">Post</button>';
      if (mode === 'photo') {
        return [
          '<textarea id="composer-text" rows="3" placeholder="Add a caption..."></textarea>',
          '<input id="photo-input" type="file" accept="image/*" capture="environment">',
          state.composer.photoPreview ? '<img class="photo-preview" src="' + escapeHtml(state.composer.photoPreview) + '" alt="Photo preview">' : '<p class="hint">Photos are resized before upload.</p>',
          postButton
        ].join('');
      }

      if (mode === 'song') {
        const preview = state.composer.songUrl ? detectSongClient(state.composer.songUrl) : null;
        return [
          '<textarea id="composer-text" rows="3" placeholder="Why this song?"></textarea>',
          '<input id="song-url" class="text-input" type="url" placeholder="Paste Spotify, YouTube, or Apple Music URL" value="' + escapeHtml(state.composer.songUrl) + '">',
          preview ? renderSongEmbed(state.composer.songUrl, preview.embedUrl, preview.platform) : '',
          postButton
        ].join('');
      }

      if (mode === 'voice') {
        return [
          '<textarea id="composer-text" rows="3" placeholder="Add a note..."></textarea>',
          state.composer.voicePreview ? '<audio class="voice-preview" controls src="' + escapeHtml(state.composer.voicePreview) + '"></audio>' : '<p class="hint">Record a short voice note.</p>',
          '<div class="button-row">',
          '<button class="secondary" data-action="start-voice-recording" ' + (state.composer.recording ? 'disabled' : '') + '>Record</button>',
          '<button class="secondary" data-action="stop-voice-recording" ' + (!state.composer.recording ? 'disabled' : '') + '>Stop</button>',
          '</div>',
          postButton
        ].join('');
      }

      return [
        '<textarea id="composer-text" rows="7" placeholder="Share a thought..."></textarea>',
        postButton
      ].join('');
    }

    function renderUs() {
      const active = state.us.subtab;
      return [
        '<section class="us-shell">',
        '<div class="subtabs">',
        '<button class="subtab' + (active === 'bucket' ? ' active' : '') + '" data-us-tab="bucket">Bucket List</button>',
        '<button class="subtab' + (active === 'reunions' ? ' active' : '') + '" data-us-tab="reunions">Reunions</button>',
        '</div>',
        active === 'bucket' ? renderBucket() : renderReunions(),
        '</section>'
      ].join('');
    }

    function renderBucket() {
      if (state.us.bucket.loading && !state.us.bucket.loaded) {
        return '<div class="card skeleton-card"></div>';
      }

      return [
        renderBucketForm(),
        renderBucketOpenItems(),
        renderBucketDoneItems()
      ].join('');
    }

    function renderBucketForm() {
      return [
        '<section class="card compact-form">',
        '<h2>Add something</h2>',
        '<input id="bucket-text" class="text-input" type="text" placeholder="A place, food, or experience">',
        '<select id="bucket-category" class="text-input">',
        ['place', 'food', 'experience', 'other'].map(function(category) {
          return '<option value="' + category + '">' + titleCase(category) + '</option>';
        }).join(''),
        '</select>',
        '<button class="primary wide" data-action="add-bucket">Add</button>',
        '</section>'
      ].join('');
    }

    function renderBucketOpenItems() {
      const groups = groupBy(state.us.bucket.open, 'category');
      const categories = ['place', 'food', 'experience', 'other'].filter(function(category) {
        return groups[category] && groups[category].length;
      });

      if (!categories.length) {
        return '<section class="card placeholder"><h2>Open ideas</h2><p>What do you want to do together?</p></section>';
      }

      return categories.map(function(category) {
        return [
          '<section class="bucket-group">',
          '<h3>' + titleCase(category) + '</h3>',
          groups[category].map(renderBucketItem).join(''),
          '</section>'
        ].join('');
      }).join('');
    }

    function renderBucketItem(item) {
      return [
        '<article class="list-item">',
        '<button class="check-action" data-action="toggle-bucket" data-item-id="' + escapeHtml(item.id) + '" aria-label="Mark done"></button>',
        '<div>',
        '<strong>' + escapeHtml(item.text) + '</strong>',
        '<p>' + escapeHtml(item.addedByName || '') + '</p>',
        '</div>',
        '<button class="text-action" data-action="delete-bucket" data-item-id="' + escapeHtml(item.id) + '">delete</button>',
        '</article>'
      ].join('');
    }

    function renderBucketDoneItems() {
      const done = state.us.bucket.done || [];
      if (!done.length) return '';

      return [
        '<section class="done-section">',
        '<button class="link-row" data-action="toggle-done-list">Done together (' + done.length + ')</button>',
        state.us.bucket.showDone ? done.map(function(item) {
          return [
            '<article class="list-item done">',
            '<span class="check-action checked"></span>',
            '<div><strong>' + escapeHtml(item.text) + '</strong>',
            item.doneNote ? '<p>' + escapeHtml(item.doneNote) + '</p>' : '<p>Done</p>',
            '</div>',
            '<button class="text-action" data-action="toggle-bucket" data-item-id="' + escapeHtml(item.id) + '">undo</button>',
            '</article>'
          ].join('');
        }).join('') : '',
        '</section>'
      ].join('');
    }

    function renderReunions() {
      if (state.us.reunions.loading && !state.us.reunions.loaded) {
        return '<div class="card skeleton-card"></div>';
      }

      return [
        renderNextReunionCard(),
        renderReunionForm(),
        renderReunionList('Upcoming', state.us.reunions.upcoming, false),
        renderPastReunions()
      ].join('');
    }

    function renderNextReunionCard() {
      const next = state.us.reunions.next;
      if (!next) {
        return '<section class="today-hero small"><span class="hero-number">-</span><span class="hero-label">No trips planned. Yet.</span></section>';
      }

      return [
        '<section class="today-hero small">',
        '<span class="hero-number">' + escapeHtml(next.daysUntil) + '</span>',
        '<span class="hero-label">days until ' + escapeHtml(next.location || next.title) + '</span>',
        '</section>'
      ].join('');
    }

    function renderReunionForm() {
      const editing = state.us.editingReunionId ? findByIdClient(state.us.reunions.upcoming.concat(state.us.reunions.past), state.us.editingReunionId) : null;
      return [
        '<section class="card compact-form">',
        '<h2>' + (editing ? 'Edit reunion' : 'Add reunion') + '</h2>',
        '<input id="reunion-title" class="text-input" type="text" placeholder="Title" value="' + escapeHtml(editing ? editing.title : '') + '">',
        '<input id="reunion-start" class="text-input" type="date" value="' + escapeHtml(editing ? editing.startDate : '') + '">',
        '<input id="reunion-end" class="text-input" type="date" value="' + escapeHtml(editing ? editing.endDate : '') + '">',
        '<input id="reunion-location" class="text-input" type="text" placeholder="Location" value="' + escapeHtml(editing ? editing.location : '') + '">',
        '<textarea id="reunion-notes" rows="3" placeholder="Notes...">' + escapeHtml(editing ? editing.notes : '') + '</textarea>',
        '<div class="button-row">',
        '<button class="primary wide" data-action="' + (editing ? 'update-reunion' : 'add-reunion') + '">' + (editing ? 'Save' : 'Add') + '</button>',
        editing ? '<button class="secondary" data-action="cancel-reunion-edit">Cancel</button>' : '',
        '</div>',
        '</section>'
      ].join('');
    }

    function renderReunionList(title, items, past) {
      if (!items.length) return '';
      return [
        '<section class="reunion-list">',
        '<h3>' + escapeHtml(title) + '</h3>',
        items.map(function(item) {
          return renderReunionItem(item, past);
        }).join(''),
        '</section>'
      ].join('');
    }

    function renderPastReunions() {
      const past = state.us.reunions.past || [];
      if (!past.length) return '';
      return [
        '<section class="done-section">',
        '<button class="link-row" data-action="toggle-past-reunions">Past reunions (' + past.length + ')</button>',
        state.us.reunions.showPast ? renderReunionList('', past, true) : '',
        '</section>'
      ].join('');
    }

    function renderReunionItem(item, past) {
      return [
        '<article class="list-item reunion-item">',
        '<div>',
        '<strong>' + escapeHtml(item.title) + '</strong>',
        '<p>' + escapeHtml(formatDateRange(item.startDate, item.endDate, item.location)) + '</p>',
        item.notes ? '<p>' + escapeHtml(item.notes) + '</p>' : '',
        '</div>',
        '<div class="item-actions">',
        '<button class="text-action" data-action="edit-reunion" data-reunion-id="' + escapeHtml(item.id) + '">edit</button>',
        '<button class="text-action" data-action="delete-reunion" data-reunion-id="' + escapeHtml(item.id) + '">delete</button>',
        '</div>',
        '</article>'
      ].join('');
    }

    function renderMemories() {
      if (state.memories.loading && !state.memories.loaded) {
        return '<section class="memory-wrap"><div class="card skeleton-card"></div></section>';
      }

      if (!state.memories.memory) {
        return [
          '<section class="memory-wrap">',
          '<article class="card memory-card">',
          '<p class="eyebrow">Memories</p>',
          '<h2>No old memories yet</h2>',
          '<p>' + escapeHtml(state.memories.message || 'Once you have posts or answered questions older than 30 days, they will show up here.') + '</p>',
          '<button class="primary wide" data-action="show-memory">Check again</button>',
          '</article>',
          renderCapsules(),
          '</section>'
        ].join('');
      }

      return [
        '<section class="memory-wrap">',
        renderMemoryCard(state.memories.memory),
        '<button class="primary wide" data-action="show-memory">Show me another</button>',
        renderCapsules(),
        '</section>'
      ].join('');
    }

    function renderMemoryCard(memory) {
      if (memory.type === 'question') {
        return [
          '<article class="card memory-card">',
          '<p class="eyebrow">' + escapeHtml(memory.date) + '</p>',
          '<h2>' + escapeHtml(memory.question.text) + '</h2>',
          renderAnswers(memory.answers || []),
          '</article>'
        ].join('');
      }

      return [
        '<article class="card memory-card">',
        '<p class="eyebrow">' + escapeHtml(memory.date) + '</p>',
        '<div class="memory-post">',
        renderFeedPost(memory.post),
        '</div>',
        '</article>'
      ].join('');
    }

    function renderCapsules() {
      const capsules = state.memories.capsules;
      const unlocked = capsules.unlocked || [];
      const locked = capsules.locked || [];
      return [
        '<section class="card capsule-card">',
        '<h2>Time capsules</h2>',
        '<textarea id="capsule-text" rows="4" placeholder="Write a letter for later..."></textarea>',
        '<input id="capsule-unlock" class="text-input" type="date">',
        '<button class="primary wide" data-action="create-capsule">Seal letter</button>',
        unlocked.length ? '<div class="capsule-list">' + unlocked.map(renderCapsule).join('') + '</div>' : '<p class="hint">Unlocked letters will appear here.</p>',
        locked.length ? '<p class="hint">' + locked.length + ' sealed for later.</p>' : '',
        '</section>'
      ].join('');
    }

    function renderCapsule(capsule) {
      return [
        '<article class="capsule-item">',
        '<p class="eyebrow">' + escapeHtml(capsule.unlockDate) + ' · ' + escapeHtml(capsule.authorName) + '</p>',
        '<p>' + escapeHtml(capsule.text) + '</p>',
        capsule.opened ? '<span class="hint">Opened</span>' : '<button class="text-action" data-action="open-capsule" data-capsule-id="' + escapeHtml(capsule.id) + '">mark opened</button>',
        '</article>'
      ].join('');
    }

    function renderPlaceholderTab() {
      return '<section class="card placeholder"><h2>' + titleCase(state.activeTab) + '</h2><p>Coming in a later phase.</p></section>';
    }

    function renderTabs() {
      return '<nav class="tabbar">' + ['today', 'feed', 'us', 'memories'].map(function(tab) {
        const active = state.activeTab === tab ? ' active' : '';
        return '<button class="tab' + active + '" data-tab="' + tab + '">' + titleCase(tab) + '</button>';
      }).join('') + '</nav>';
    }

    function bindEvents() {
      root.querySelectorAll('[data-tab]').forEach(function(button) {
        button.addEventListener('click', function() {
          state.activeTab = button.getAttribute('data-tab');
          if (state.activeTab === 'feed' && !state.feed.loaded) loadFeed(true);
          if (state.activeTab === 'us' && (!state.us.bucket.loaded || !state.us.reunions.loaded)) loadUs();
          if (state.activeTab === 'memories' && !state.memories.loaded) loadMemory();
          render();
        });
      });

      root.querySelectorAll('[data-us-tab]').forEach(function(button) {
        button.addEventListener('click', function() {
          state.us.subtab = button.getAttribute('data-us-tab');
          if (!state.us.bucket.loaded || !state.us.reunions.loaded) loadUs();
          render();
        });
      });

      const reload = root.querySelector('[data-action="reload"]');
      if (reload) reload.addEventListener('click', loadToday);

      const revealAnswers = root.querySelector('[data-action="reveal-answers"]');
      if (revealAnswers) {
        revealAnswers.addEventListener('click', function() {
          state.ui.revealAnswers = true;
          render();
        });
      }

      const enableNotifications = root.querySelector('[data-action="enable-notifications"]');
      if (enableNotifications) enableNotifications.addEventListener('click', requestNotifications);

      const dismissNotifications = root.querySelector('[data-action="dismiss-notifications"]');
      if (dismissNotifications) {
        dismissNotifications.addEventListener('click', function() {
          state.ui.showNotificationBanner = false;
          localStorage.setItem('us_notifications_dismissed', 'true');
          render();
        });
      }

      const dismissInstallTip = root.querySelector('[data-action="dismiss-install-tip"]');
      if (dismissInstallTip) {
        dismissInstallTip.addEventListener('click', function() {
          state.ui.showInstallTip = false;
          localStorage.setItem('us_install_tip_dismissed', 'true');
          render();
        });
      }

      root.querySelectorAll('[data-action="show-memory"]').forEach(function(button) {
        button.addEventListener('click', loadMemory);
      });

      const createCapsuleButton = root.querySelector('[data-action="create-capsule"]');
      if (createCapsuleButton) createCapsuleButton.addEventListener('click', createCapsule);

      root.querySelectorAll('[data-action="open-capsule"]').forEach(function(button) {
        button.addEventListener('click', function() {
          apiPost('openCapsule', { id: button.getAttribute('data-capsule-id') })
            .then(function(result) {
              if (!result.ok) throw new Error(result.error || 'Open failed');
              applyCapsules(result.data.capsules);
            })
            .catch(function(err) { showToast(humanError(err.message)); });
        });
      });

      root.querySelectorAll('[data-action="open-composer"]').forEach(function(button) {
        button.addEventListener('click', function() {
          state.composer.open = true;
          render();
        });
      });

      document.querySelectorAll('[data-action="close-composer"]').forEach(function(node) {
        node.addEventListener('click', closeComposer);
      });

      document.querySelectorAll('[data-composer-mode]').forEach(function(button) {
        button.addEventListener('click', function() {
          state.composer.mode = button.getAttribute('data-composer-mode');
          render();
        });
      });

      const songUrl = document.getElementById('song-url');
      if (songUrl) {
        songUrl.addEventListener('change', function() {
          state.composer.songUrl = songUrl.value.trim();
          render();
        });
      }

      const photoInput = document.getElementById('photo-input');
      if (photoInput) {
        photoInput.addEventListener('change', function() {
          const file = photoInput.files && photoInput.files[0];
          if (!file) return;
          resizePhoto(file)
            .then(function(photo) {
              state.composer.photoBase64 = photo.base64;
              state.composer.photoMimeType = photo.mimeType;
              state.composer.photoPreview = photo.preview;
              render();
            })
            .catch(function() {
              showToast('Could not prepare that photo.');
            });
        });
      }

      const publish = document.querySelector('[data-action="publish-post"]');
      if (publish) publish.addEventListener('click', publishPost);

      document.querySelectorAll('img[data-drive-id]').forEach(function(image) {
        image.addEventListener('error', function() {
          const fileId = image.getAttribute('data-drive-id');
          if (!fileId || image.dataset.fallbackTried === 'true') return;
          image.dataset.fallbackTried = 'true';
          image.src = 'https://drive.google.com/thumbnail?id=' + encodeURIComponent(fileId) + '&sz=w1600';
        });
      });

      const thinkingOfYou = root.querySelector('[data-action="thinking-of-you"]');
      if (thinkingOfYou) {
        thinkingOfYou.addEventListener('click', function() {
          thinkingOfYou.disabled = true;
          apiPost('sendThinkingOfYou')
            .then(function(result) {
              if (!result.ok) throw new Error(result.error || 'Nudge failed');
              showToast('Sent.');
            })
            .catch(function(err) {
              showToast(humanError(err.message));
              thinkingOfYou.disabled = false;
            });
        });
      }

      const dailyPhotoButton = root.querySelector('[data-action="submit-daily-photo"]');
      if (dailyPhotoButton) dailyPhotoButton.addEventListener('click', submitDailyPhoto);

      const startVoice = document.querySelector('[data-action="start-voice-recording"]');
      if (startVoice) startVoice.addEventListener('click', startVoiceRecording);

      const stopVoice = document.querySelector('[data-action="stop-voice-recording"]');
      if (stopVoice) stopVoice.addEventListener('click', stopVoiceRecording);

      const addBucket = root.querySelector('[data-action="add-bucket"]');
      if (addBucket) addBucket.addEventListener('click', addBucketItem);

      root.querySelectorAll('[data-action="toggle-bucket"]').forEach(function(button) {
        button.addEventListener('click', function() {
          toggleBucketItem(button.getAttribute('data-item-id'));
        });
      });

      root.querySelectorAll('[data-action="delete-bucket"]').forEach(function(button) {
        button.addEventListener('click', function() {
          const itemId = button.getAttribute('data-item-id');
          if (!confirm('Delete this bucket list item?')) return;
          apiPost('deleteBucketItem', { itemId: itemId })
            .then(function(result) {
              if (!result.ok) throw new Error(result.error || 'Delete failed');
              applyBucket(result.data.bucket);
            })
            .catch(function(err) { showToast(humanError(err.message)); });
        });
      });

      const toggleDone = root.querySelector('[data-action="toggle-done-list"]');
      if (toggleDone) {
        toggleDone.addEventListener('click', function() {
          state.us.bucket.showDone = !state.us.bucket.showDone;
          render();
        });
      }

      const addReunionButton = root.querySelector('[data-action="add-reunion"]');
      if (addReunionButton) addReunionButton.addEventListener('click', saveNewReunion);

      const updateReunionButton = root.querySelector('[data-action="update-reunion"]');
      if (updateReunionButton) updateReunionButton.addEventListener('click', saveExistingReunion);

      const cancelReunionEdit = root.querySelector('[data-action="cancel-reunion-edit"]');
      if (cancelReunionEdit) {
        cancelReunionEdit.addEventListener('click', function() {
          state.us.editingReunionId = '';
          render();
        });
      }

      root.querySelectorAll('[data-action="edit-reunion"]').forEach(function(button) {
        button.addEventListener('click', function() {
          state.us.editingReunionId = button.getAttribute('data-reunion-id');
          window.scrollTo({ top: 0, behavior: 'smooth' });
          render();
        });
      });

      root.querySelectorAll('[data-action="delete-reunion"]').forEach(function(button) {
        button.addEventListener('click', function() {
          const id = button.getAttribute('data-reunion-id');
          if (!confirm('Delete this reunion?')) return;
          apiPost('deleteReunion', { id: id })
            .then(function(result) {
              if (!result.ok) throw new Error(result.error || 'Delete failed');
              applyReunions(result.data.reunions);
              loadToday();
            })
            .catch(function(err) { showToast(humanError(err.message)); });
        });
      });

      const togglePast = root.querySelector('[data-action="toggle-past-reunions"]');
      if (togglePast) {
        togglePast.addEventListener('click', function() {
          state.us.reunions.showPast = !state.us.reunions.showPast;
          render();
        });
      }

      root.querySelectorAll('[data-action="heart-post"]').forEach(function(button) {
        button.addEventListener('click', function() {
          const postId = button.getAttribute('data-post-id');
          button.disabled = true;
          apiPost('heartPost', { postId: postId })
            .then(function(result) {
              if (!result.ok) throw new Error(result.error || 'Heart failed');
              replaceFeedPost(result.data.post);
            })
            .catch(function(err) {
              showToast(humanError(err.message));
            });
        });
      });

      root.querySelectorAll('[data-action="delete-post"]').forEach(function(button) {
        button.addEventListener('click', function() {
          const postId = button.getAttribute('data-post-id');
          if (!confirm('Delete this post?')) return;
          apiPost('softDeletePost', { postId: postId })
            .then(function(result) {
              if (!result.ok) throw new Error(result.error || 'Delete failed');
              state.feed.items = state.feed.items.filter(function(post) { return post.id !== postId; });
              render();
            })
            .catch(function(err) {
              showToast(humanError(err.message));
            });
        });
      });

      const submit = root.querySelector('[data-action="submit-answer"]');
      if (submit) {
        submit.addEventListener('click', function() {
          const answer = root.querySelector('#answer').value.trim();
          if (!answer) return showToast('Write an answer first.');
          submit.disabled = true;
          apiPost('submitAnswer', { questionLogId: state.today.question.questionLogId, answer: answer })
            .then(function(result) {
              if (!result.ok) throw new Error(result.error || 'Submit failed');
              return loadToday();
            })
            .catch(function(err) {
              showToast(humanError(err.message));
              submit.disabled = false;
            });
        });
      }

      root.querySelectorAll('[data-action="status"]').forEach(function(button) {
        button.addEventListener('click', function() {
          const type = button.getAttribute('data-type');
          button.disabled = true;
          apiPost('logMorningNight', { type: type })
            .then(function(result) {
              if (!result.ok) throw new Error(result.error || 'Status failed');
              return loadToday();
            })
            .catch(function(err) {
              showToast(humanError(err.message));
              button.disabled = false;
            });
        });
      });
    }

    function setupGlobalTapFallbacks() {
      if (window.__US_GLOBAL_TAPS_BOUND__) return;
      window.__US_GLOBAL_TAPS_BOUND__ = true;

      ['pointerup', 'touchend', 'click'].forEach(function(eventName) {
        document.addEventListener(eventName, function(event) {
          const target = event.target && event.target.closest ? event.target.closest('[data-action]') : null;
          if (!target || !root.contains(target)) return;
          const action = target.getAttribute('data-action');

          if (action === 'enable-notifications') {
            event.preventDefault();
            event.stopPropagation();
            if (Date.now() - (window.__US_LAST_NOTIFICATION_TAP__ || 0) < 900) return;
            window.__US_LAST_NOTIFICATION_TAP__ = Date.now();
            requestNotifications();
          }

          if (action === 'dismiss-notifications') {
            event.preventDefault();
            event.stopPropagation();
            state.ui.showNotificationBanner = false;
            localStorage.setItem('us_notifications_dismissed', 'true');
            render();
          }
        }, true);
      });
    }

    function publishPost() {
      const publish = document.querySelector('[data-action="publish-post"]');
      const text = (document.getElementById('composer-text') || {}).value || '';
      const mode = state.composer.mode;
      const payload = { type: mode, text: text.trim() };

      if (mode === 'photo') {
        if (!state.composer.photoBase64) return showToast('Choose a photo first.');
        payload.mediaBase64 = state.composer.photoBase64;
        payload.mediaMimeType = state.composer.photoMimeType;
      }

      if (mode === 'song') {
        const songUrl = (document.getElementById('song-url') || {}).value || '';
        if (!songUrl.trim()) return showToast('Paste a song link first.');
        payload.songUrl = songUrl.trim();
      }

      if (mode === 'voice') {
        if (!state.composer.voiceBase64) return showToast('Record a voice note first.');
        payload.mediaBase64 = state.composer.voiceBase64;
        payload.mediaMimeType = state.composer.voiceMimeType;
      }

      if (mode === 'text' && !payload.text) return showToast('Write something first.');

      publish.disabled = true;
      apiPost('createPost', payload)
        .then(function(result) {
          if (!result.ok) throw new Error(result.error || 'Post failed');
          state.feed.items.unshift(result.data.post);
          state.feed.loaded = true;
          closeComposer();
        })
        .catch(function(err) {
          showToast(humanError(err.message));
          publish.disabled = false;
        });
    }

    function requestNotifications() {
      logPushDiagnostic(null, 'button_pressed');
      if (!config.onesignal_app_id) {
        showToast('Notifications are not configured yet.');
        return;
      }

      if (!('Notification' in window)) {
        state.ui.showNotificationBanner = false;
        localStorage.setItem('us_notifications_dismissed', 'true');
        render();
        return;
      }

      state.ui.showNotificationBanner = false;
      localStorage.setItem('us_notifications_dismissed', 'true');
      render();

      let oneSignalCallbackStarted = false;
      window.setTimeout(function() {
        if (!oneSignalCallbackStarted) {
          logPushDiagnostic(null, window.OneSignal && window.OneSignal.Notifications ? 'onesignal_callback_timeout' : 'onesignal_sdk_missing');
          showToast('Notification setup did not start. I logged a diagnostic.');
        }
      }, 3500);

      window.OneSignalDeferred = window.OneSignalDeferred || [];
      window.OneSignalDeferred.push(function(OneSignal) {
        oneSignalCallbackStarted = true;
        logPushDiagnostic(OneSignal, 'onesignal_callback_started');
        attachPushSubscriptionListener(OneSignal);
        attachNotificationDebugListeners(OneSignal);
        identifyOneSignalUser(OneSignal);
        if (OneSignal.Notifications && OneSignal.Notifications.isPushSupported && !OneSignal.Notifications.isPushSupported()) {
          logPushDiagnostic(OneSignal, 'not_supported');
          showToast(humanError('push_not_supported'));
          return;
        }
        serviceWorkerReadyPromise.then(function() {
          logPushDiagnostic(OneSignal, 'permission_request_start');
          return requestNotificationPermissionWithFallback(OneSignal);
        }).then(function(permission) {
          if (permission === false || Notification.permission === 'denied') throw new Error('notifications_denied');
          return OneSignal.User && OneSignal.User.PushSubscription && OneSignal.User.PushSubscription.optIn
            ? OneSignal.User.PushSubscription.optIn()
            : null;
        }).then(function() {
          identifyOneSignalUser(OneSignal);
          return waitForPushSubscriptionId(OneSignal, 8000);
        }).then(function(playerId) {
          return registerCurrentPushDevice(OneSignal, playerId);
        }).then(function() {
          showToast('Notifications enabled.');
        }).catch(function(err) {
          logPushDiagnostic(OneSignal, err && err.message ? err.message : 'notifications_not_ready');
          showToast(humanError(err && err.message ? err.message : 'notifications_not_ready'));
        });
      });
    }

    function setupOneSignal() {
      if (!config.onesignal_app_id || !window.OneSignalDeferred) return;
      window.OneSignalDeferred.push(function(OneSignal) {
        OneSignal.init({
          appId: config.onesignal_app_id,
          safari_web_id: config.onesignal_safari_web_id || undefined,
          serviceWorkerPath: config.service_worker_path || '?r=sw',
          serviceWorkerParam: { scope: config.service_worker_scope || './' },
          notifyButton: { enable: false },
          autoResubscribe: true,
          allowLocalhostAsSecureOrigin: true
        }).then(function() {
          serviceWorkerReadyPromise = waitForServiceWorkerReady(OneSignal, 'after_onesignal_init');
          attachPushSubscriptionListener(OneSignal);
          identifyOneSignalUser(OneSignal);
          return serviceWorkerReadyPromise.catch(function() { return null; });
        }).catch(function(err) {
          logPushDiagnostic(OneSignal, err && err.message ? 'onesignal_init_or_ready_failed:' + err.message : 'onesignal_init_or_ready_failed');
          return null;
        });
      });
    }

    function attachPushSubscriptionListener(OneSignal) {
      if (!OneSignal || !OneSignal.User || !OneSignal.User.PushSubscription || !OneSignal.User.PushSubscription.addEventListener) return;
      if (window.__US_PUSH_LISTENER_ATTACHED__) return;
      window.__US_PUSH_LISTENER_ATTACHED__ = true;
      OneSignal.User.PushSubscription.addEventListener('change', function(event) {
        const id = (event && event.current && event.current.id) || OneSignal.User.PushSubscription.id || '';
        logPushDiagnostic(OneSignal, id ? 'push_subscription_changed_with_id' : 'push_subscription_changed_no_id');
        if (id) registerCurrentPushDevice(OneSignal, id).catch(function() {});
      });
    }

    function attachNotificationDebugListeners(OneSignal) {
      if (!OneSignal || !OneSignal.Notifications || !OneSignal.Notifications.addEventListener) return;
      if (window.__US_NOTIFICATION_LISTENERS_ATTACHED__) return;
      window.__US_NOTIFICATION_LISTENERS_ATTACHED__ = true;
      OneSignal.Notifications.addEventListener('permissionPromptDisplay', function() {
        logPushDiagnostic(OneSignal, 'permission_prompt_displayed');
      });
      OneSignal.Notifications.addEventListener('permissionChange', function(permission) {
        logPushDiagnostic(OneSignal, 'permission_change:' + String(permission));
      });
    }

    function requestNotificationPermissionWithFallback(OneSignal) {
      const oneSignalPermission = OneSignal && OneSignal.Notifications && OneSignal.Notifications.requestPermission
        ? OneSignal.Notifications.requestPermission()
        : Promise.reject(new Error('onesignal_permission_missing'));

      return withTimeout(oneSignalPermission, 7000, 'onesignal_permission_timeout')
        .catch(function(err) {
          logPushDiagnostic(OneSignal, err && err.message ? err.message : 'onesignal_permission_failed');
          if (Notification.permission !== 'default' || !Notification.requestPermission) throw err;
          logPushDiagnostic(OneSignal, 'native_permission_fallback_start');
          return withTimeout(Notification.requestPermission(), 7000, 'native_permission_timeout');
        });
    }

    function waitForServiceWorkerReady(OneSignal, reason) {
      if (!('serviceWorker' in navigator)) return Promise.reject(new Error('service_worker_missing'));
      logPushDiagnostic(OneSignal, 'service_worker_wait:' + reason);
      return withTimeout(navigator.serviceWorker.ready, 9000, 'service_worker_ready_timeout')
        .then(function(registration) {
          logPushDiagnostic(OneSignal, 'service_worker_ready:' + reason);
          return registration;
        })
        .catch(function(err) {
          logPushDiagnostic(OneSignal, err && err.message ? err.message : 'service_worker_ready_failed');
          throw err;
        });
    }

    function withTimeout(promise, timeoutMs, message) {
      return new Promise(function(resolve, reject) {
        let settled = false;
        const timer = window.setTimeout(function() {
          if (settled) return;
          settled = true;
          reject(new Error(message));
        }, timeoutMs);
        Promise.resolve(promise).then(function(value) {
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          resolve(value);
        }).catch(function(err) {
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          reject(err);
        });
      });
    }

    function identifyOneSignalUser(OneSignal) {
      if (!OneSignal || !user || !user.email || !OneSignal.login) return Promise.resolve();
      return Promise.resolve(OneSignal.login(String(user.email).toLowerCase())).catch(function() {});
    }

    function registerCurrentPushDevice(OneSignal, knownPlayerId) {
      const playerId = knownPlayerId || (OneSignal && OneSignal.User && OneSignal.User.PushSubscription
        ? OneSignal.User.PushSubscription.id
        : '');
      if (!playerId) return Promise.resolve();
      return apiPost('registerPushDevice', {
        playerId: playerId,
        deviceLabel: navigator.userAgent
      });
    }

    function logPushDiagnostic(OneSignal, reason) {
      const push = OneSignal && OneSignal.User && OneSignal.User.PushSubscription ? OneSignal.User.PushSubscription : {};
      apiPost('logPushDiagnostic', {
        reason: reason,
        notificationPermission: 'Notification' in window ? Notification.permission : 'missing',
        oneSignalPermission: OneSignal && OneSignal.Notifications ? OneSignal.Notifications.permission : '',
        pushSupported: OneSignal && OneSignal.Notifications && OneSignal.Notifications.isPushSupported ? OneSignal.Notifications.isPushSupported() : '',
        subscriptionId: push.id || '',
        subscriptionToken: push.token || '',
        optedIn: typeof push.optedIn === 'boolean' ? push.optedIn : '',
        standalone: window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone || false,
        serviceWorkerController: Boolean(navigator.serviceWorker && navigator.serviceWorker.controller),
        userAgent: navigator.userAgent
      }).catch(function() {});
    }

    function waitForPushSubscriptionId(OneSignal, timeoutMs) {
      return new Promise(function(resolve, reject) {
        const started = Date.now();
        function readId() {
          return OneSignal && OneSignal.User && OneSignal.User.PushSubscription
            ? OneSignal.User.PushSubscription.id
            : '';
        }
        const initial = readId();
        if (initial) {
          resolve(initial);
          return;
        }
        const timer = setInterval(function() {
          const id = readId();
          if (id) {
            clearInterval(timer);
            resolve(id);
            return;
          }
          if (Date.now() - started > timeoutMs) {
            clearInterval(timer);
            reject(new Error('push_subscription_missing'));
          }
        }, 350);
      });
    }

    function submitDailyPhoto() {
      const input = document.getElementById('daily-photo-input');
      const file = input && input.files && input.files[0];
      if (!file) return showToast('Choose a photo first.');
      resizePhoto(file)
        .then(function(photo) {
          return apiPost('submitDailyPhoto', {
            mediaBase64: photo.base64,
            mediaMimeType: photo.mimeType
          });
        })
        .then(function(result) {
          if (!result.ok) throw new Error(result.error || 'Photo failed');
          state.today.dailyPhoto = result.data.dailyPhoto;
          render();
        })
        .catch(function(err) {
          showToast(humanError(err.message));
        });
    }

    function startVoiceRecording() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
        showToast('Voice recording is not available in this browser.');
        return;
      }

      navigator.mediaDevices.getUserMedia({ audio: true })
        .then(function(stream) {
          const recorder = new MediaRecorder(stream);
          state.composer.voiceChunks = [];
          state.composer.recorder = recorder;
          recorder.ondataavailable = function(event) {
            if (event.data && event.data.size) state.composer.voiceChunks.push(event.data);
          };
          recorder.onstop = function() {
            const mimeType = recorder.mimeType || 'audio/webm';
            const blob = new Blob(state.composer.voiceChunks, { type: mimeType });
            stream.getTracks().forEach(function(track) { track.stop(); });
            blobToBase64(blob).then(function(base64) {
              state.composer.voiceBase64 = base64;
              state.composer.voiceMimeType = mimeType;
              state.composer.voicePreview = URL.createObjectURL(blob);
              state.composer.recording = false;
              state.composer.recorder = null;
              render();
            });
          };
          recorder.start();
          state.composer.recording = true;
          render();
        })
        .catch(function() {
          showToast('Microphone access was not allowed.');
        });
    }

    function stopVoiceRecording() {
      if (state.composer.recorder && state.composer.recording) {
        state.composer.recorder.stop();
      }
    }

    function addBucketItem() {
      const text = (document.getElementById('bucket-text') || {}).value || '';
      const category = (document.getElementById('bucket-category') || {}).value || 'other';
      if (!text.trim()) return showToast('Add a bucket list idea first.');

      apiPost('addBucketItem', { text: text.trim(), category: category })
        .then(function(result) {
          if (!result.ok) throw new Error(result.error || 'Add failed');
          applyBucket(result.data.bucket);
        })
        .catch(function(err) { showToast(humanError(err.message)); });
    }

    function createCapsule() {
      const text = ((document.getElementById('capsule-text') || {}).value || '').trim();
      const unlockDate = ((document.getElementById('capsule-unlock') || {}).value || '').trim();
      apiPost('createCapsule', { text: text, unlockDate: unlockDate })
        .then(function(result) {
          if (!result.ok) throw new Error(result.error || 'Capsule failed');
          applyCapsules(result.data.capsules);
        })
        .catch(function(err) { showToast(humanError(err.message)); });
    }

    function toggleBucketItem(itemId) {
      const item = findByIdClient(state.us.bucket.open.concat(state.us.bucket.done), itemId);
      const note = item && !item.done ? prompt('Add a where/when note?') || '' : '';
      apiPost('toggleBucketDone', { itemId: itemId, note: note })
        .then(function(result) {
          if (!result.ok) throw new Error(result.error || 'Update failed');
          applyBucket(result.data.bucket);
        })
        .catch(function(err) { showToast(humanError(err.message)); });
    }

    function saveNewReunion() {
      const payload = readReunionForm();
      apiPost('addReunion', payload)
        .then(function(result) {
          if (!result.ok) throw new Error(result.error || 'Add failed');
          applyReunions(result.data.reunions);
          loadToday();
        })
        .catch(function(err) { showToast(humanError(err.message)); });
    }

    function saveExistingReunion() {
      const payload = readReunionForm();
      payload.id = state.us.editingReunionId;
      apiPost('updateReunion', payload)
        .then(function(result) {
          if (!result.ok) throw new Error(result.error || 'Save failed');
          state.us.editingReunionId = '';
          applyReunions(result.data.reunions);
          loadToday();
        })
        .catch(function(err) { showToast(humanError(err.message)); });
    }

    function readReunionForm() {
      return {
        title: ((document.getElementById('reunion-title') || {}).value || '').trim(),
        startDate: ((document.getElementById('reunion-start') || {}).value || '').trim(),
        endDate: ((document.getElementById('reunion-end') || {}).value || '').trim(),
        location: ((document.getElementById('reunion-location') || {}).value || '').trim(),
        notes: ((document.getElementById('reunion-notes') || {}).value || '').trim()
      };
    }

    function applyBucket(bucket) {
      state.us.bucket.open = bucket.open || [];
      state.us.bucket.done = bucket.done || [];
      state.us.bucket.loaded = true;
      render();
    }

    function applyReunions(reunions) {
      state.us.reunions.next = reunions.next || null;
      state.us.reunions.upcoming = reunions.upcoming || [];
      state.us.reunions.past = reunions.past || [];
      state.us.reunions.loaded = true;
      render();
    }

    function applyCapsules(capsules) {
      state.memories.capsules.unlocked = capsules.unlocked || [];
      state.memories.capsules.locked = capsules.locked || [];
      state.memories.capsules.loaded = true;
      render();
    }

    function closeComposer() {
      state.composer = {
        open: false,
        mode: 'text',
        photoBase64: '',
        photoMimeType: '',
        photoPreview: '',
        songUrl: '',
        voiceBase64: '',
        voiceMimeType: '',
        voicePreview: '',
        recording: false,
        recorder: null,
        voiceChunks: []
      };
      render();
    }

    function getExternalToken() {
      return externalFrontend ? String(localStorage.getItem('us_frontend_token') || '').trim() : '';
    }

    function replaceFeedPost(post) {
      state.feed.items = state.feed.items.map(function(item) {
        return item.id === post.id ? post : item;
      });
      render();
    }

    function groupBy(items, key) {
      return (items || []).reduce(function(groups, item) {
        const value = item[key] || 'other';
        groups[value] = groups[value] || [];
        groups[value].push(item);
        return groups;
      }, {});
    }

    function findByIdClient(items, id) {
      return (items || []).find(function(item) {
        return item.id === id;
      }) || null;
    }

    function formatDateRange(startDate, endDate, location) {
      const start = formatClientDate(startDate);
      const end = formatClientDate(endDate);
      const dates = end && end !== start ? start + ' to ' + end : start;
      return [dates, location].filter(Boolean).join(' · ');
    }

    function formatClientDate(value) {
      const text = String(value || '').trim();
      const match = text.match(/^(\d{4}-\d{2}-\d{2})/);
      if (match) return match[1];
      const date = new Date(text);
      if (!Number.isFinite(date.getTime())) return text;
      return date.toISOString().slice(0, 10);
    }

    function resizePhoto(file) {
      return new Promise(function(resolve, reject) {
        const reader = new FileReader();
        reader.onload = function() {
          const image = new Image();
          image.onload = function() {
            const maxEdge = 1600;
            const scale = Math.min(1, maxEdge / Math.max(image.width, image.height));
            const canvas = document.createElement('canvas');
            canvas.width = Math.round(image.width * scale);
            canvas.height = Math.round(image.height * scale);
            const ctx = canvas.getContext('2d');
            ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
            const dataUrl = canvas.toDataURL('image/jpeg', 0.82);
            resolve({
              base64: dataUrl.split(',')[1],
              mimeType: 'image/jpeg',
              preview: dataUrl
            });
          };
          image.onerror = reject;
          image.src = reader.result;
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
    }

    function blobToBase64(blob) {
      return new Promise(function(resolve, reject) {
        const reader = new FileReader();
        reader.onloadend = function() {
          resolve(String(reader.result || '').split(',')[1] || '');
        };
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    }

    function latestStatusText(statuses) {
      if (!statuses.length) return '';
      const latest = statuses.slice().sort(function(a, b) {
        return String(b.timestamp).localeCompare(String(a.timestamp));
      })[0];
      const today = state.today || {};
      const current = today.user || user;
      const other = today.otherUser || {};
      const name = String(latest.user_email).toLowerCase() === String(current.email || '').toLowerCase()
        ? current.name
        : other.name;
      return name + ' said good ' + latest.type + ' today.';
    }

    function detectSongClient(songUrl) {
      const url = String(songUrl || '').trim();
      let match = url.match(/open\.spotify\.com\/track\/([A-Za-z0-9]+)/);
      if (match) return { platform: 'spotify', embedUrl: 'https://open.spotify.com/embed/track/' + match[1] };
      match = url.match(/[?&]v=([A-Za-z0-9_-]+)/) || url.match(/youtu\.be\/([A-Za-z0-9_-]+)/);
      if (match) return { platform: 'youtube', embedUrl: 'https://www.youtube.com/embed/' + match[1] };
      if (/music\.apple\.com\//.test(url)) return { platform: 'apple', embedUrl: 'https://embed.music.apple.com' + url.replace(/^https?:\/\/music\.apple\.com/, '') };
      return { platform: 'link', embedUrl: '' };
    }

    function isIosSafari() {
      const ua = navigator.userAgent || '';
      const isiOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
      const isSafari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
      return isiOS && isSafari;
    }

    function relativeTime(value) {
      const then = new Date(value).getTime();
      if (!Number.isFinite(then)) return '';
      const seconds = Math.max(1, Math.floor((Date.now() - then) / 1000));
      if (seconds < 60) return 'just now';
      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) return minutes + 'm ago';
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return hours + 'h ago';
      const days = Math.floor(hours / 24);
      return days + 'd ago';
    }

    function gasRun(functionName) {
      const args = Array.prototype.slice.call(arguments, 1);
      return new Promise(function(resolve, reject) {
        if (!(window.google && google.script && google.script.run)) {
          reject(new Error('google_script_run_unavailable'));
          return;
        }

        google.script.run
          .withSuccessHandler(function(value) {
            if (value == null) {
              reject(new Error('empty_server_response'));
              return;
            }
            if (typeof value === 'string') {
              try {
                resolve(JSON.parse(value));
              } catch (err) {
                reject(new Error('invalid_server_json'));
              }
              return;
            }
            resolve(value);
          })
          .withFailureHandler(function(err) {
            reject(new Error(err && err.message ? err.message : 'server_error'));
          })[functionName].apply(google.script.run, args);
      });
    }

    function apiGet(action, params) {
      if (externalFrontend) return externalApi('get', action, params || {});
      return gasRun('clientApiGet', action, params || {});
    }

    function apiPost(action, payload) {
      if (externalFrontend) return externalApi('post', action, payload || {});
      return gasRun('clientApiPost', Object.assign({ action: action }, payload || {}));
    }

    function externalApi(method, action, payload) {
      if (!config.web_app_url) return Promise.reject(new Error('missing_backend_url'));
      const token = getExternalToken();
      if (!token) return Promise.reject(new Error('unauthorized'));
      const body = Object.assign({}, payload || {});
      if (method === 'post') body.action = action;
      const encodedPayload = base64UrlEncode(JSON.stringify(body));
      if (encodedPayload.length > 7000) {
        return Promise.reject(new Error('payload_too_large_for_static_frontend'));
      }
      const callbackName = '__us_jsonp_' + Date.now() + '_' + Math.floor(Math.random() * 100000);
      const separator = config.web_app_url.indexOf('?') === -1 ? '?' : '&';
      const src = config.web_app_url + separator +
        'r=xapi&method=' + encodeURIComponent(method) +
        '&action=' + encodeURIComponent(action) +
        '&token=' + encodeURIComponent(token) +
        '&payload=' + encodeURIComponent(encodedPayload) +
        '&callback=' + encodeURIComponent(callbackName);

      return new Promise(function(resolve, reject) {
        const script = document.createElement('script');
        const timer = window.setTimeout(function() {
          cleanup();
          reject(new Error('backend_timeout'));
        }, 20000);

        function cleanup() {
          window.clearTimeout(timer);
          delete window[callbackName];
          if (script.parentNode) script.parentNode.removeChild(script);
        }

        window[callbackName] = function(response) {
          cleanup();
          resolve(response);
        };

        script.onerror = function() {
          cleanup();
          reject(new Error('backend_unreachable'));
        };
        script.src = src;
        document.head.appendChild(script);
      });
    }

    function base64UrlEncode(text) {
      const bytes = new TextEncoder().encode(text);
      let binary = '';
      bytes.forEach(function(byte) {
        binary += String.fromCharCode(byte);
      });
      return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }

    function showToast(message) {
      state.error = message;
      render();
      setTimeout(function() {
        state.error = '';
        render();
      }, 4000);
    }

    function humanError(error) {
      const map = {
        answer_required: 'Write an answer first.',
        question_locked_until_tonight: "Today's question unlocks tonight.",
        invalid_status_type: 'That status is not available.',
        questions_not_seeded: 'Questions have not been seeded yet. Run setup again.',
        invalid_post_type: 'Choose a valid post type.',
        post_text_required: 'Write something first.',
        photo_required: 'Choose a photo first.',
        voice_required: 'Record a voice note first.',
        voice_too_large: 'That voice note is too large.',
        song_url_required: 'Paste a song link first.',
        post_not_found: 'That post is no longer available.',
        cannot_heart_own_post: 'You can only heart posts from the other person.',
        delete_not_allowed: 'You can only delete your own posts.',
        delete_window_expired: 'Posts can only be deleted for five minutes.',
        bucket_text_required: 'Add a bucket list idea first.',
        bucket_item_not_found: 'That bucket list item is gone.',
        invalid_bucket_category: 'Choose a valid bucket list category.',
        reunion_title_required: 'Add a reunion title.',
        reunion_start_required: 'Add a start date.',
        reunion_not_found: 'That reunion is gone.',
        push_subscription_missing: 'Notification permission worked, but this browser did not create a push subscription.',
        push_not_supported: 'This browser is not reporting web push support for this app.',
        notifications_denied: 'Notifications are blocked for this app.',
        notifications_not_ready: 'Notifications are not ready yet.',
        service_worker_ready_timeout: 'Notification setup could not install the service worker.',
        service_worker_missing: 'This browser does not expose service workers for this app.',
        missing_backend_url: 'Backend URL is missing in app-config.js.',
        payload_too_large_for_static_frontend: 'That upload is too large for the static frontend bridge.',
        backend_timeout: 'The backend did not respond in time.',
        backend_unreachable: 'The backend could not be reached.',
        nudge_rate_limited: 'Give it a few minutes before sending another one.',
        capsule_text_required: 'Write the letter first.',
        capsule_unlock_required: 'Choose an unlock date.',
        capsule_not_found: 'That letter is gone.',
        capsule_locked: 'That letter is still sealed.'
      };
      if (/failed to fetch|network/i.test(String(error || ''))) {
        return "Couldn't reach the sheet. Try again in a sec.";
      }
      if (error === 'server_error') {
        return 'Server error. Run getRecentApiErrors() in Apps Script for details.';
      }
      return map[error] || error || 'Something went wrong.';
    }

    function titleCase(value) {
      return String(value).charAt(0).toUpperCase() + String(value).slice(1);
    }

    function escapeHtml(value) {
      return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    }

    init();
  })();
