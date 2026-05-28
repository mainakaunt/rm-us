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
        loaded: false,
        voiceData: {},
        voiceLoading: {},
        voiceErrors: {}
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
    let pendingRouteFocus = '';

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
      applyRouteFromUrl();
      render();
      loadToday();
      loadActiveTabData();
      window.addEventListener('scroll', maybeLoadMoreFeed, { passive: true });
      window.addEventListener('resize', setupMobileViewport, { passive: true });
      window.addEventListener('popstate', function() {
        applyRouteFromUrl();
        render();
        loadActiveTabData();
      });
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
      // Postmark redesign: no scale hack. Rely on responsive CSS so position:fixed
      // (tabbar, fab, sheets) is not trapped inside a transformed containing block.
      document.documentElement.style.removeProperty('--app-mobile-scale');
      document.documentElement.style.removeProperty('--app-layout-width');
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
      const cachedToday = readCache('today');
      if (!state.today && cachedToday) {
        state.today = cachedToday;
      }
      state.loading = true;
      render();
      apiGet('getToday')
        .then(function(result) {
          if (!result.ok) throw new Error(result.error || 'Failed to load today');
          if (state.today && state.today.date !== result.data.date) {
            state.ui.revealAnswers = false;
          }
          state.today = result.data;
          writeCache('today', state.today);
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
        const cachedFeed = readCache('feed');
        if (!state.feed.loaded && cachedFeed && cachedFeed.items) {
          state.feed.items = cachedFeed.items || [];
          state.feed.nextCursor = cachedFeed.nextCursor || null;
          state.feed.hasMore = Boolean(cachedFeed.hasMore);
          state.feed.loaded = true;
        }
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
          if (reset) {
            writeCache('feed', {
              items: state.feed.items,
              nextCursor: state.feed.nextCursor,
              hasMore: state.feed.hasMore
            });
          }
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
        '<div class="eyebrow"><span>— private</span><span>access denied</span></div>',
        '<h1>Us.</h1>',
        '<p>this letter is only for two pairs of eyes. sign in with the right account.</p>',
        '<div class="meta">sign in · then reload</div>',
        '</section>'
      ].join('');
    }

    function renderExternalLogin(message) {
      root.innerHTML = [
        '<section class="external-login">',
        '<div class="card">',
        '<div class="eyebrow"><span>— open us</span></div>',
        '<h2>a private letter.</h2>',
        '<p>paste your token once. it stays on this device.</p>',
        message ? '<p class="form-error">' + escapeHtml(message) + '</p>' : '',
        '<input id="frontend-token" class="text-input" type="password" autocomplete="off" placeholder="frontend token">',
        '<button type="button" class="primary wide" data-action="save-frontend-token">Continue</button>',
        '</div>',
        '</section>'
      ].join('');

      const input = document.getElementById('frontend-token');
      const button = root.querySelector('[data-action="save-frontend-token"]');
      if (button) {
        button.addEventListener('click', function() {
          const token = input ? input.value.trim() : '';
          if (!token) return showToast('Paste your frontend token first.');
          localStorage.setItem('us_frontend_token', JSON.stringify({ token: token, expires: Date.now() + 90 * 24 * 60 * 60 * 1000 }));
          initExternalFrontend();
        });
      }
    }

    function render() {
      root.innerHTML = [
        '<section class="phone-shell">',
        renderClockStrip(),
        '<div class="screen screen-' + state.activeTab + '">',
        renderActiveTab(),
        '</div>',
        '</section>',
        renderTabs(),
        state.activeTab === 'feed' ? '<button class="fab" data-action="open-composer" aria-label="Create post">+</button>' : '',
        state.composer.open ? renderComposer() : '',
        state.error ? '<div class="toast">' + escapeHtml(state.error) + '</div>' : ''
      ].join('');
      bindEvents();
      scrollToPendingFocus();
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
        return '<span class="clock"><em>' + escapeHtml(clock.name) + '</em> ' + escapeHtml(clock.time + weather) + '</span>';
      }).join('<span class="dot" aria-hidden="true"></span>') + '</div>';
    }

    function renderToday() {
      if (state.loading && !state.today) {
        return [
          '<div class="hero-skeleton"></div>',
          '<div class="block"><div class="button-row"><div class="button-skeleton"></div><div class="button-skeleton"></div></div></div>',
          '<div class="skeleton-card"></div>'
        ].join('');
      }

      const today = state.today;
      if (!today) {
        return '<section class="block"><h2 class="q-title" style="font-family:var(--font-serif);font-style:italic;font-size:32px;color:var(--ink);margin-bottom:14px;">Today</h2><p class="hint">Could not load today yet.</p><button class="primary wide" data-action="reload" style="margin-top:14px;">Try again</button></section>';
      }

      return [
        renderCountdown(today.nextReunion, today),
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
        '<section class="block">',
        '<div class="inline-banner notification-banner">',
        '<div class="notification-copy">',
        '<strong>— Notifications</strong>',
        '<p>Hear from ' + escapeHtml(partner) + ' the moment something arrives.</p>',
        '</div>',
        '<div class="notification-actions">',
        '<button type="button" class="mini-action notification-enable" data-action="enable-notifications">Enable</button>',
        '<button type="button" class="mini-action muted" data-action="dismiss-notifications">Not now</button>',
        '</div>',
        '</div>',
        '</section>'
      ].join('');
    }

    function renderInstallTip() {
      if (!state.ui.showInstallTip) return '';
      return [
        '<section class="block">',
        '<div class="install-tip">',
        '<p>Tap Share → Add to Home Screen to keep <em style="font-family:var(--font-serif);">Us</em> close.</p>',
        '<button class="text-action" data-action="dismiss-install-tip">dismiss</button>',
        '</div>',
        '</section>'
      ].join('');
    }

    function renderCountdown(nextReunion, today) {
      const dateLine = today && today.user ? formatHumanDate(state.today && state.today.date) : '';
      const dayOfUs = today && today.relationshipStats && today.relationshipStats.daysTogether != null
        ? 'day ' + escapeHtml(today.relationshipStats.daysTogether) + ' of us'
        : '';
      const stamp = dateLine
        ? '<div class="band-stamp">' + escapeHtml(dateLine) + '</div>'
        : '';

      if (!nextReunion) {
        return [
          '<section class="postmark-band empty">',
          stamp,
          '<div class="band-eyebrow">until —</div>',
          '<div class="band-hero">',
          '<span class="hero-number">soon</span>',
          '<div class="hero-label">no reunion <strong>set</strong> yet — plan it.</div>',
          dayOfUs ? '<div class="hero-sub">' + dayOfUs + '</div>' : '',
          '</div>',
          '</section>'
        ].join('');
      }

      const place = nextReunion.location || nextReunion.title || 'next reunion';
      const days = nextReunion.daysUntil == null ? '—' : nextReunion.daysUntil;
      const arrival = nextReunion.startDate ? 'arr. ' + escapeHtml(formatHumanDate(nextReunion.startDate)) : '';
      const sub = [arrival, dayOfUs].filter(Boolean).join(' · ');

      return [
        '<section class="postmark-band">',
        stamp,
        '<div class="band-eyebrow">until —</div>',
        '<div class="band-hero">',
        '<span class="hero-number">' + escapeHtml(days) + '</span>',
        '<div class="hero-label">days until <strong>' + escapeHtml(place) + '</strong></div>',
        sub ? '<div class="hero-sub">' + sub + '</div>' : '',
        '</div>',
        '</section>'
      ].join('');
    }

    function renderQuestionCard(today) {
      const question = today.question || {};
      const disabled = today.answered.me || question.locked;
      const answerCopy = today.answered.other ? today.otherUser.name + ' already wrote back' : today.otherUser.name + ' hasn\u2019t answered yet';
      const textarea = today.answered.me
        ? '<p class="answered-note">— you answered today.</p>'
        : '<textarea id="answer" rows="5" placeholder="begin softly..." ' + (disabled ? 'disabled' : '') + '></textarea>';
      const button = today.answered.me
        ? ''
        : '<button class="primary wide" data-action="submit-answer" ' + (disabled ? 'disabled' : '') + '>Send</button>';

      const answers = today.answers && state.ui.revealAnswers ? renderAnswers(today.answers) : '';
      const revealPrompt = today.answers && !state.ui.revealAnswers
        ? '<button class="link-row" data-action="reveal-answers">Both answered — open the letters</button>'
        : '';

      return [
        '<section class="block question-card" data-focus="question">',
        '<div class="eyebrow">',
        "<span>Today\u2019s question · " + escapeHtml(question.category || 'daily') + '</span>',
        '<span>·</span>',
        '</div>',
        '<h2>' + formatQuestionText(question.text || '') + '</h2>',
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
        ? '<div class="milestone">— ' + escapeHtml(stats.nextMilestone.label) + ' in <strong style="font-style:normal;color:var(--mark);">' + escapeHtml(stats.nextMilestone.daysUntil) + '</strong> days</div>'
        : '';
      const thinking = today.thinking || {};
      const thinkingNote = thinking.latestReceived
        ? '<p class="hint">— ' + escapeHtml(thinking.latestReceived.name) + ' thought of you ' + escapeHtml(relativeTime(thinking.latestReceived.createdAt)) + '</p>'
        : (thinking.latestSent ? '<p class="hint">— you sent one ' + escapeHtml(relativeTime(thinking.latestSent.createdAt)) + '</p>' : '');
      return [
        '<section class="stats-strip" data-focus="thinking stats">',
        '<div class="stat"><strong>' + escapeHtml(stats.daysTogether == null ? '—' : stats.daysTogether) + '</strong><span>days together</span></div>',
        '<div class="stat"><strong>' + escapeHtml(today.answerStreak || 0) + '</strong><span>answer streak</span></div>',
        milestone,
        '<div class="thinking"><button data-action="thinking-of-you">Thinking of you</button>' + thinkingNote + '</div>',
        '</section>'
      ].join('');
    }

    function renderDailyPhoto(dailyPhoto) {
      if (!dailyPhoto) return '';
      const photos = dailyPhoto.photos || [];
      const reveal = photos.length >= 2;
      return [
        '<section class="block daily-photo-card" data-focus="daily-photo">',
        '<div class="eyebrow"><span>Daily photo</span><span>' + escapeHtml(dailyPhoto.date || '') + '</span></div>',
        reveal ? '<div class="daily-photo-grid">' + photos.map(function(photo) {
          return [
            '<figure>',
            '<img src="' + escapeHtml(photo.mediaUrl) + '" alt="' + escapeHtml(photo.name) + ' daily photo" loading="lazy">',
            '<figcaption>' + escapeHtml(photo.name) + '</figcaption>',
            '</figure>'
          ].join('');
        }).join('') + '</div>' : '<p class="hint">' + (dailyPhoto.meSubmitted ? '— your photo is in. waiting for the other.' : 'add today\u2019s photo. it reveals when both arrive.') + '</p>',
        '<input id="daily-photo-input" type="file" accept="image/*" capture="environment">',
        '<button class="secondary wide" data-action="submit-daily-photo">' + (dailyPhoto.meSubmitted ? "Replace today\u2019s photo" : "Add today\u2019s photo") + '</button>',
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
        '<section class="block status-panel" data-focus="status">',
        '<div class="eyebrow"><span>Status</span><span>·</span></div>',
        '<div class="button-row">',
        '<button class="secondary" data-action="status" data-type="morning">good morning ☀</button>',
        '<button class="secondary" data-action="status" data-type="night">good night ☽</button>',
        '</div>',
        latest ? '<p class="hint">' + escapeHtml(latest) + '</p>' : '<p class="hint">— no notes today yet.</p>',
        '</section>'
      ].join('');
    }

    function renderFeed() {
      if (state.feed.loading && !state.feed.loaded) {
        return '<section class="feed-list"><div class="skeleton-card" style="margin:0;height:200px;"></div><div class="skeleton-card" style="margin:0;height:160px;"></div></section>';
      }

      if (!state.feed.items.length) {
        return [
          '<section class="empty-feed">',
          '<div class="eyebrow" style="justify-content:center;"><span>— the feed</span></div>',
          '<h2>nothing here yet.</h2>',
          '<p>you write the first letter.</p>',
          '<button class="primary" data-action="open-composer">Write something</button>',
          '</section>'
        ].join('');
      }

      return [
        '<section class="feed-list">',
        state.feed.items.map(renderFeedPost).join(''),
        state.feed.loadingMore ? '<p class="feed-loading">— loading more</p>' : '',
        !state.feed.hasMore ? '<p class="feed-loading">— caught up</p>' : '',
        '</section>'
      ].join('');
    }

    function renderFeedPost(post) {
      return [
        '<article class="feed-post" data-post-id="' + escapeHtml(post.id) + '">',
        '<header class="post-header">',
        '<span class="avatar">' + escapeHtml(post.authorInitial || '?') + '</span>',
        '<div><strong>' + escapeHtml(post.authorName) + '</strong><p>' + escapeHtml(postmarkTime(post.createdAt)) + '</p></div>',
        '</header>',
        renderPostContent(post),
        '<footer class="post-actions">',
        '<div class="post-action-left">',
        post.canHeart ? '<button class="icon-action' + (post.heartedByOther ? ' hearted' : '') + '" data-action="heart-post" data-post-id="' + escapeHtml(post.id) + '" aria-label="Heart post">' + (post.heartedByOther ? '♥' : '♡') + '</button>' : '<span class="heart-state">' + (post.heartedByOther ? '♥ hearted' : '') + '</span>',
        '</div>',
        post.canDelete ? '<button class="text-action" data-action="delete-post" data-post-id="' + escapeHtml(post.id) + '">delete</button>' : '<span></span>',
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
        const voice = state.feed.voiceData[post.id];
        const audioSrc = voice && voice.base64 ? voiceAudioSource(voice) : post.mediaDownloadUrl || post.mediaUrl || '';
        return [
          post.text ? '<p class="post-text">' + escapeHtml(post.text) + '</p>' : '',
          audioSrc ? '<audio class="voice-player" controls preload="metadata" src="' + escapeHtml(audioSrc) + '" data-post-id="' + escapeHtml(post.id) + '"></audio>' : '',
          post.mediaDownloadUrl ? '<a class="voice-open-link" href="' + escapeHtml(post.mediaDownloadUrl) + '" target="_blank" rel="noopener">Open if it will not play</a>' : ''
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

    function voiceAudioSource(voice) {
      const mimeTypes = Array.isArray(voice.mimeTypes) && voice.mimeTypes.length ? voice.mimeTypes : [voice.mimeType || 'audio/mp4'];
      const index = Math.min(Math.max(Number(voice.candidateIndex || 0), 0), mimeTypes.length - 1);
      const mimeType = mimeTypes[index] || 'audio/mp4';
      if (voice.objectUrl && voice.objectMimeType === mimeType) return voice.objectUrl;
      if (voice.objectUrl) URL.revokeObjectURL(voice.objectUrl);
      voice.objectUrl = URL.createObjectURL(base64ToBlob(voice.base64, mimeType));
      voice.objectMimeType = mimeType;
      return voice.objectUrl;
    }

    function base64ToBlob(base64, mimeType) {
      const clean = String(base64 || '').replace(/^data:[^,]+,/, '');
      const binary = atob(clean);
      const chunkSize = 32768;
      const chunks = [];
      for (let offset = 0; offset < binary.length; offset += chunkSize) {
        const slice = binary.slice(offset, offset + chunkSize);
        const bytes = new Uint8Array(slice.length);
        for (let i = 0; i < slice.length; i += 1) {
          bytes[i] = slice.charCodeAt(i);
        }
        chunks.push(bytes);
      }
      return new Blob(chunks, { type: mimeType || 'audio/mp4' });
    }

    function loadVoiceData(postId, reason) {
      if (!postId || state.feed.voiceLoading[postId]) return Promise.resolve();
      if (state.feed.voiceData[postId] && state.feed.voiceData[postId].base64) return Promise.resolve();

      state.feed.voiceLoading[postId] = true;
      state.feed.voiceErrors[postId] = reason === 'drive_audio_error' ? 'Loading voice note...' : '';
      render();

      return apiGet('getVoiceData', { postId: postId })
        .then(function(result) {
          if (!result.ok) throw new Error(result.error || 'Voice failed');
          state.feed.voiceData[postId] = Object.assign({ candidateIndex: 0 }, result.data || {});
          state.feed.voiceErrors[postId] = '';
        })
        .catch(function(err) {
          state.feed.voiceErrors[postId] = humanError(err.message);
          logClientDiagnostic('voice_load_failed', {
            postId: postId,
            message: String(err && err.message || err)
          });
        })
        .finally(function() {
          state.feed.voiceLoading[postId] = false;
          render();
        });
    }

    function renderComposer() {
      const mode = state.composer.mode;
      return [
        '<div class="sheet-backdrop" data-action="close-composer"></div>',
        '<section class="bottom-sheet" role="dialog" aria-modal="true">',
        '<div class="sheet-handle"></div>',
        '<div class="eyebrow" style="margin:0 0 4px;"><span>— write</span><span>' + escapeHtml(titleCase(mode)) + '</span></div>',
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
      const postButton = '<button class="primary wide" data-action="publish-post">Send</button>';
      if (mode === 'photo') {
        return [
          '<textarea id="composer-text" rows="3" placeholder="a small note for the photo..."></textarea>',
          '<input id="photo-input" type="file" accept="image/*" capture="environment">',
          state.composer.photoPreview ? '<img class="photo-preview" src="' + escapeHtml(state.composer.photoPreview) + '" alt="Photo preview">' : '<p class="hint">— photos are gently resized before sending.</p>',
          postButton
        ].join('');
      }

      if (mode === 'song') {
        const preview = state.composer.songUrl ? detectSongClient(state.composer.songUrl) : null;
        return [
          '<textarea id="composer-text" rows="3" placeholder="why this song?"></textarea>',
          '<input id="song-url" class="text-input" type="url" placeholder="Spotify, YouTube, or Apple Music URL" value="' + escapeHtml(state.composer.songUrl) + '">',
          preview ? renderSongEmbed(state.composer.songUrl, preview.embedUrl, preview.platform) : '',
          postButton
        ].join('');
      }

      if (mode === 'voice') {
        return [
          '<textarea id="composer-text" rows="3" placeholder="a line for the voice note..."></textarea>',
          state.composer.voicePreview ? '<audio class="voice-preview" controls src="' + escapeHtml(state.composer.voicePreview) + '"></audio>' : '<p class="hint">— record a short voice note.</p>',
          '<div class="button-row">',
          '<button class="secondary" data-action="start-voice-recording" ' + (state.composer.recording ? 'disabled' : '') + '>● Record</button>',
          '<button class="secondary" data-action="stop-voice-recording" ' + (!state.composer.recording ? 'disabled' : '') + '>Stop</button>',
          '</div>',
          postButton
        ].join('');
      }

      return [
        '<textarea id="composer-text" rows="7" placeholder="share a thought, write it like a letter..."></textarea>',
        postButton
      ].join('');
    }

    function renderUs() {
      const active = state.us.subtab;
      return [
        '<section class="us-shell">',
        '<div class="subtabs">',
        '<button class="subtab' + (active === 'bucket' ? ' active' : '') + '" data-us-tab="bucket">Bucket list</button>',
        '<button class="subtab' + (active === 'reunions' ? ' active' : '') + '" data-us-tab="reunions">Reunions</button>',
        '</div>',
        active === 'bucket' ? renderBucket() : renderReunions(),
        '</section>'
      ].join('');
    }

    function renderBucket() {
      if (state.us.bucket.loading && !state.us.bucket.loaded) {
        return '<div class="skeleton-card"></div>';
      }

      return [
        renderBucketForm(),
        renderBucketOpenItems(),
        renderBucketDoneItems()
      ].join('');
    }

    function renderBucketForm() {
      return [
        '<section class="block compact-form">',
        '<div class="eyebrow"><span>— add an idea</span></div>',
        '<input id="bucket-text" class="text-input" type="text" placeholder="a place, food, or experience">',
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
        return '<section class="placeholder" style="padding:36px 22px;text-align:left;"><h2 style="font-size:28px;">Open ideas</h2><p>what do you want to do <em style="font-style:italic;color:var(--mark);">together</em>?</p></section>';
      }

      return categories.map(function(category) {
        return [
          '<section class="bucket-group">',
          '<h3>— ' + titleCase(category) + '</h3>',
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
        '<p>added by ' + escapeHtml(item.addedByName || '—') + '</p>',
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
        state.us.bucket.showDone ? '<div>' + done.map(function(item) {
          return [
            '<article class="list-item done">',
            '<span class="check-action checked"></span>',
            '<div><strong>' + escapeHtml(item.text) + '</strong>',
            item.doneNote ? '<p style="font-family:var(--font-serif);font-style:italic;font-size:14px;letter-spacing:0;text-transform:none;color:var(--ink-soft);margin-top:4px;">' + escapeHtml(item.doneNote) + '</p>' : '<p>done</p>',
            '</div>',
            '<button class="text-action" data-action="toggle-bucket" data-item-id="' + escapeHtml(item.id) + '">undo</button>',
            '</article>'
          ].join('');
        }).join('') + '</div>' : '',
        '</section>'
      ].join('');
    }

    function renderReunions() {
      if (state.us.reunions.loading && !state.us.reunions.loaded) {
        return '<div class="skeleton-card"></div>';
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
        return [
          '<section class="postmark-band small empty">',
          '<div class="band-eyebrow">next reunion</div>',
          '<div class="band-hero">',
          '<span class="hero-number">soon.</span>',
          '<div class="hero-label">no trips planned <strong>yet</strong>.</div>',
          '</div>',
          '</section>'
        ].join('');
      }

      const arrival = next.startDate ? 'arr. ' + escapeHtml(formatHumanDate(next.startDate)) : '';
      return [
        '<section class="postmark-band small">',
        arrival ? '<div class="band-stamp">' + arrival + '</div>' : '',
        '<div class="band-eyebrow">next reunion</div>',
        '<div class="band-hero">',
        '<span class="hero-number">' + escapeHtml(next.daysUntil) + '</span>',
        '<div class="hero-label">days until <strong>' + escapeHtml(next.location || next.title) + '</strong></div>',
        '</div>',
        '</section>'
      ].join('');
    }

    function renderReunionForm() {
      const editing = state.us.editingReunionId ? findByIdClient(state.us.reunions.upcoming.concat(state.us.reunions.past), state.us.editingReunionId) : null;
      return [
        '<section class="block compact-form">',
        '<div class="eyebrow"><span>— ' + (editing ? 'edit reunion' : 'add reunion') + '</span></div>',
        '<input id="reunion-title" class="text-input" type="text" placeholder="title" value="' + escapeHtml(editing ? editing.title : '') + '">',
        '<div class="button-row">',
        '<input id="reunion-start" class="text-input" type="date" value="' + escapeHtml(editing ? editing.startDate : '') + '">',
        '<input id="reunion-end" class="text-input" type="date" value="' + escapeHtml(editing ? editing.endDate : '') + '">',
        '</div>',
        '<input id="reunion-location" class="text-input" type="text" placeholder="location" value="' + escapeHtml(editing ? editing.location : '') + '">',
        '<textarea id="reunion-notes" rows="3" placeholder="notes...">' + escapeHtml(editing ? editing.notes : '') + '</textarea>',
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
        title ? '<h3>— ' + escapeHtml(title) + '</h3>' : '',
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
        return '<section class="memory-wrap"><div class="skeleton-card" style="margin:0;"></div></section>';
      }

      if (!state.memories.memory) {
        return [
          '<section class="memory-wrap" style="text-align:left;">',
          '<article class="memory-card">',
          '<div class="eyebrow"><span>— memories</span></div>',
          '<h2>nothing old enough yet.</h2>',
          '<p class="hint">' + escapeHtml(state.memories.message || 'once you have posts or answered questions older than 30 days, they will show up here.') + '</p>',
          '<button class="primary wide" data-action="show-memory">Check again</button>',
          '</article>',
          renderCapsules(),
          '</section>'
        ].join('');
      }

      return [
        '<section class="memory-wrap" style="text-align:left;">',
        renderMemoryCard(state.memories.memory),
        '<div style="padding:0 22px;"><button class="primary wide" data-action="show-memory">Show me another</button></div>',
        renderCapsules(),
        '</section>'
      ].join('');
    }

    function renderMemoryCard(memory) {
      if (memory.type === 'question') {
        return [
          '<article class="memory-card">',
          '<div class="eyebrow"><span>' + escapeHtml(memory.date) + '</span><span>a question</span></div>',
          '<h2>' + formatQuestionText(memory.question.text) + '</h2>',
          renderAnswers(memory.answers || []),
          '</article>'
        ].join('');
      }

      return [
        '<article class="memory-card">',
        '<div class="eyebrow"><span>' + escapeHtml(memory.date) + '</span><span>a post</span></div>',
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
        '<section class="capsule-card" data-focus="capsules">',
        '<div class="eyebrow"><span>— time capsules</span>' + (locked.length ? '<span>' + locked.length + ' sealed</span>' : '<span>·</span>') + '</div>',
        '<h2>write a letter for later.</h2>',
        '<textarea id="capsule-text" rows="4" placeholder="a letter to open another day..."></textarea>',
        '<input id="capsule-unlock" class="text-input" type="date">',
        '<button class="primary wide" data-action="create-capsule">Seal letter</button>',
        unlocked.length ? '<div class="capsule-list">' + unlocked.map(renderCapsule).join('') + '</div>' : '<p class="hint">— unlocked letters will appear here.</p>',
        '</section>'
      ].join('');
    }

    function renderCapsule(capsule) {
      return [
        '<article class="capsule-item">',
        '<div class="eyebrow"><span>' + escapeHtml(capsule.unlockDate) + '</span><span>from ' + escapeHtml(capsule.authorName) + '</span></div>',
        '<p>' + escapeHtml(capsule.text) + '</p>',
        capsule.opened ? '<span class="hint" style="font-size:13px;">— opened</span>' : '<button class="text-action" data-action="open-capsule" data-capsule-id="' + escapeHtml(capsule.id) + '" style="margin-top:8px;">mark opened</button>',
        '</article>'
      ].join('');
    }

    function renderPlaceholderTab() {
      return '<section class="placeholder"><h2>' + titleCase(state.activeTab) + '</h2><p>coming soon.</p></section>';
    }

    function renderTabs() {
      const labels = { today: 'Today', feed: 'Feed', us: 'Us', memories: 'Memo.' };
      return '<nav class="tabbar">' + ['today', 'feed', 'us', 'memories'].map(function(tab) {
        const active = state.activeTab === tab ? ' active' : '';
        return '<button class="tab' + active + '" data-tab="' + tab + '">' + labels[tab] + '</button>';
      }).join('') + '</nav>';
    }

    function bindEvents() {
      root.querySelectorAll('[data-tab]').forEach(function(button) {
        button.addEventListener('click', function() {
          activateTab(button.getAttribute('data-tab'), true);
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
              return loadToday();
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
              if (result.data && result.data.post) {
                replaceFeedPost(result.data.post);
              } else {
                return loadFeed(true);
              }
            })
            .catch(function(err) {
              showToast(humanError(err.message));
            });
        });
      });

      root.querySelectorAll('[data-action="load-voice"]').forEach(function(button) {
        button.addEventListener('click', function() {
          const postId = button.getAttribute('data-post-id');
          loadVoiceData(postId);
        });
      });

      root.querySelectorAll('.voice-player').forEach(function(player) {
        player.addEventListener('error', function() {
          const postId = player.getAttribute('data-post-id');
          if (!state.feed.voiceData[postId]) {
            loadVoiceData(postId, 'native_audio_error');
            return;
          }
          const voice = state.feed.voiceData[postId];
          const mimeTypes = voice && Array.isArray(voice.mimeTypes) ? voice.mimeTypes : [];
          const nextIndex = Number(voice && voice.candidateIndex || 0) + 1;
          logClientDiagnostic('voice_inline_audio_error', {
            postId: postId,
            mimeType: mimeTypes[Number(voice && voice.candidateIndex || 0)] || '',
            mediaError: player.error ? player.error.code : ''
          });
          if (voice && nextIndex < mimeTypes.length) {
            voice.candidateIndex = nextIndex;
            state.feed.voiceErrors[postId] = '';
          } else {
            state.feed.voiceErrors[postId] = 'Could not play here. Open voice note.';
          }
          render();
        }, { once: true });
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
      if (externalFrontend && (mode === 'photo' || mode === 'voice')) {
        publishMediaPost(payload, publish);
        return;
      }
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
        logPushDiagnostic(OneSignal, 'permission_request_start');
        requestNotificationPermissionWithFallback(OneSignal).then(function(permission) {
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
          serviceWorkerReadyPromise = waitForServiceWorkerReady(OneSignal, 'after_onesignal_init').catch(function() {
            return null;
          });
          attachPushSubscriptionListener(OneSignal);
          identifyOneSignalUser(OneSignal);
          return null;
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
        if (id && isPushPermissionGranted(OneSignal)) registerCurrentPushDevice(OneSignal, id).catch(function() {});
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
      if (OneSignal && OneSignal.User && OneSignal.User.PushSubscription && OneSignal.User.PushSubscription.id) {
        logPushDiagnostic(OneSignal, 'service_worker_bypassed_subscription_present:' + reason);
        return Promise.resolve(null);
      }
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
      if (!isPushPermissionGranted(OneSignal)) {
        logPushDiagnostic(OneSignal, 'register_skipped_permission_not_granted');
        return Promise.resolve();
      }
      return apiPost('registerPushDevice', {
        playerId: playerId,
        deviceLabel: navigator.userAgent
      });
    }

    function isPushPermissionGranted(OneSignal) {
      const push = OneSignal && OneSignal.User && OneSignal.User.PushSubscription ? OneSignal.User.PushSubscription : {};
      if (typeof push.optedIn === 'boolean' && push.optedIn) return true;
      if ('Notification' in window && Notification.permission === 'granted') return true;
      return false;
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
          if (externalFrontend) {
            const uploadId = createUploadId();
            showToast('Sending photo...');
            return externalUploadPost('submitDailyPhoto', {
              uploadId: uploadId,
              mediaBase64: photo.base64,
              mediaMimeType: photo.mimeType
            }).then(function() {
              return pollTodayForDailyPhoto(uploadId);
            }).then(function(today) {
              state.today = today;
              return { ok: true, data: { dailyPhoto: today.dailyPhoto } };
            });
          }
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

    function publishMediaPost(payload, publishButton) {
      const uploadId = createUploadId();
      const body = Object.assign({}, payload, { uploadId: uploadId });
      showToast(payload.type === 'voice' ? 'Sending voice note...' : 'Sending photo...');
      externalUploadPost('createPost', body)
        .then(function() {
          return pollFeedForUpload(uploadId);
        })
        .then(function(post) {
          state.feed.items = state.feed.items.filter(function(item) {
            return item.id !== post.id;
          });
          state.feed.items.unshift(post);
          state.feed.loaded = true;
          closeComposer();
        })
        .catch(function(err) {
          showToast(humanError(err.message));
          if (publishButton) publishButton.disabled = false;
        });
    }

    function startVoiceRecording() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
        showToast('Voice recording is not available in this browser.');
        return;
      }

      navigator.mediaDevices.getUserMedia({ audio: true })
        .then(function(stream) {
          const preferredMime = preferredAudioMimeType();
          const recorder = preferredMime ? new MediaRecorder(stream, { mimeType: preferredMime }) : new MediaRecorder(stream);
          state.composer.voiceChunks = [];
          state.composer.recorder = recorder;
          recorder.ondataavailable = function(event) {
            if (event.data && event.data.size) state.composer.voiceChunks.push(event.data);
          };
          recorder.onstop = function() {
            const firstChunk = state.composer.voiceChunks[0];
            const mimeType = recorder.mimeType || (firstChunk && firstChunk.type) || preferredMime || 'audio/mp4';
            const blob = new Blob(state.composer.voiceChunks, { type: mimeType });
            stream.getTracks().forEach(function(track) { track.stop(); });
            if (!blob.size) {
              showToast('No voice audio was recorded.');
              state.composer.recording = false;
              state.composer.recorder = null;
              render();
              return;
            }
            blobToBase64(blob).then(function(base64) {
              state.composer.voiceBase64 = base64;
              state.composer.voiceMimeType = baseMimeType(mimeType);
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

    function preferredAudioMimeType() {
      if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return '';
      const candidates = [
        'audio/mp4;codecs=mp4a.40.2',
        'audio/mp4',
        'audio/webm;codecs=opus',
        'audio/webm'
      ];
      return candidates.find(function(mimeType) {
        return MediaRecorder.isTypeSupported(mimeType);
      }) || '';
    }

    function baseMimeType(mimeType) {
      return String(mimeType || '').split(';')[0].trim().toLowerCase();
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
      if (!externalFrontend) return '';
      const raw = localStorage.getItem('us_frontend_token') || '';
      if (!raw) return '';
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && parsed.token) {
          if (parsed.expires && parsed.expires < Date.now()) {
            localStorage.removeItem('us_frontend_token');
            return '';
          }
          return String(parsed.token).trim();
        }
      } catch (e) {
        return String(raw).trim();
      }
      return '';
    }

    function readCache(key) {
      try {
        const raw = sessionStorage.getItem('us_cache_' + key);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || Date.now() - parsed.savedAt > 10 * 60 * 1000) return null;
        return parsed.value;
      } catch (err) {
        return null;
      }
    }

    function writeCache(key, value) {
      try {
        sessionStorage.setItem('us_cache_' + key, JSON.stringify({
          savedAt: Date.now(),
          value: value
        }));
      } catch (err) {
        // Cache is best-effort only.
      }
    }

    function applyRouteFromUrl() {
      const tab = getRouteTab();
      if (tab) state.activeTab = tab;
      const focus = getRouteFocus();
      pendingRouteFocus = focus;
      if (focus === 'reunions') state.us.subtab = 'reunions';
      if (focus === 'bucket') state.us.subtab = 'bucket';
    }

    function getRouteTab() {
      const params = new URLSearchParams(window.location.search || '');
      const tab = params.get('tab') || String(window.location.hash || '').replace(/^#/, '');
      return ['today', 'feed', 'us', 'memories'].indexOf(tab) !== -1 ? tab : '';
    }

    function getRouteFocus() {
      const params = new URLSearchParams(window.location.search || '');
      return params.get('focus') || '';
    }

    function scrollToPendingFocus() {
      if (!pendingRouteFocus) return;
      window.setTimeout(function() {
        const target = document.querySelector('[data-focus~="' + cssEscape(pendingRouteFocus) + '"]');
        if (!target) return;
        pendingRouteFocus = '';
        target.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }, 120);
    }

    function cssEscape(value) {
      if (window.CSS && CSS.escape) return CSS.escape(value);
      return String(value || '').replace(/[^a-zA-Z0-9_-]/g, '');
    }

    function activateTab(tab, updateUrl) {
      if (['today', 'feed', 'us', 'memories'].indexOf(tab) === -1) return;
      state.activeTab = tab;
      if (updateUrl && window.history && window.history.pushState) {
        const nextUrl = new URL(window.location.href);
        nextUrl.searchParams.set('tab', tab);
        nextUrl.searchParams.delete('focus');
        window.history.pushState({}, '', nextUrl.toString());
      }
      loadActiveTabData();
    }

    function loadActiveTabData() {
      if (state.activeTab === 'feed' && !state.feed.loaded) loadFeed(true);
      if (state.activeTab === 'us' && (!state.us.bucket.loaded || !state.us.reunions.loaded)) loadUs();
      if (state.activeTab === 'memories' && !state.memories.loaded) loadMemory();
    }

    function createUploadId() {
      if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
      return 'upload-' + Date.now() + '-' + Math.floor(Math.random() * 1000000);
    }

    function externalUploadPost(action, payload) {
      if (!config.web_app_url) return Promise.reject(new Error('missing_backend_url'));
      const token = getExternalToken();
      if (!token) return Promise.reject(new Error('unauthorized'));
      const body = Object.assign({}, payload || {}, {
        action: action,
        token: token
      });
      return fetch(config.web_app_url, {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(body),
        keepalive: false
      }).then(function() {
        return { ok: true };
      });
    }

    function pollTodayForDailyPhoto(uploadId) {
      return pollUntil(function() {
        return apiGet('getToday').then(function(result) {
          if (!result.ok) throw new Error(result.error || 'Today failed');
          const today = result.data || {};
          const dailyPhoto = today.dailyPhoto || {};
          if (dailyPhoto.myUploadId === uploadId) return today;
          return null;
        });
      }, 26000, 1800);
    }

    function pollFeedForUpload(uploadId) {
      return pollUntil(function() {
        return apiGet('getFeed', { before: '', limit: 20 }).then(function(result) {
          if (!result.ok) throw new Error(result.error || 'Feed failed');
          const data = result.data || {};
          const items = data.items || [];
          return items.find(function(item) {
            return item.uploadId === uploadId;
          }) || null;
        });
      }, 30000, 1800);
    }

    function pollUntil(check, timeoutMs, intervalMs) {
      const started = Date.now();
      return new Promise(function(resolve, reject) {
        function tick() {
          Promise.resolve()
            .then(check)
            .then(function(value) {
              if (value) {
                resolve(value);
                return;
              }
              if (Date.now() - started >= timeoutMs) {
                reject(new Error('upload_timeout'));
                return;
              }
              window.setTimeout(tick, intervalMs);
            })
            .catch(reject);
        }
        tick();
      });
    }

    function replaceFeedPost(post) {
      state.feed.items = state.feed.items.map(function(item) {
        return item.id === post.id ? post : item;
      });
      if (state.memories.memory && state.memories.memory.type === 'feed' && state.memories.memory.post && state.memories.memory.post.id === post.id) {
        state.memories.memory.post = post;
      }
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

    // ---- Postmark display helpers ----------------------------------------

    function postmarkTime(value) {
      const date = new Date(value);
      if (!Number.isFinite(date.getTime())) return relativeTime(value);
      const tz = (config && config.shared_timezone) || 'Asia/Tokyo';
      try {
        const parts = new Intl.DateTimeFormat('en', {
          timeZone: tz, day: '2-digit', month: 'short',
          hour: '2-digit', minute: '2-digit', hour12: false
        }).formatToParts(date);
        const get = function(type) { return (parts.find(function(p) { return p.type === type; }) || {}).value || ''; };
        return get('day') + ' ' + get('month').toUpperCase() + ' · ' + get('hour') + ':' + get('minute');
      } catch (e) {
        const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
        return String(date.getUTCDate()).padStart(2, '0') + ' ' + months[date.getUTCMonth()] + ' · ' +
          String(date.getUTCHours()).padStart(2, '0') + ':' + String(date.getUTCMinutes()).padStart(2, '0');
      }
    }

    function formatHumanDate(value) {
      const text = String(value || '').trim();
      if (!text) return '';
      const isoMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
      let date;
      if (isoMatch) {
        date = new Date(Number(isoMatch[1]), Number(isoMatch[2]) - 1, Number(isoMatch[3]));
      } else {
        date = new Date(text);
      }
      if (!Number.isFinite(date.getTime())) return text;
      const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      return date.getDate() + ' ' + months[date.getMonth()] + ' ' + date.getFullYear();
    }

    // Wraps the last meaningful word/phrase of a question in <em> for emphasis.
    function formatQuestionText(text) {
      const safe = escapeHtml(text || '');
      if (!safe) return '';
      // Find the last word before the final ? or end of string and italicize it.
      const match = safe.match(/^(.*?)(\s)([A-Za-z\u2019']+)([?.!]?)\s*$/);
      if (!match) return safe;
      return match[1] + match[2] + '<em>' + match[3] + '</em>' + match[4];
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

    function logClientDiagnostic(reason, details) {
      const payload = Object.assign({
        reason: reason,
        userAgent: navigator.userAgent,
        standalone: String(window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone || '')
      }, details || {});
      apiPost('logClientDiagnostic', payload).catch(function() {});
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
        question_log_missing: "Today's question needed a repair. Reload and try again.",
        stale_question_log: "Today's question changed. Reload and try again.",
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
        upload_timeout: 'The upload is still processing. Refresh in a moment before trying again.',
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
