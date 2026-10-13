// Eluvix Desktop UI Controller
(function() {
  const api = window.eluvixAPI;

  const statusPill = document.getElementById('statusPill');
  const statusText = document.getElementById('statusText');
  const copyEndpointBtn = document.getElementById('copyEndpointBtn');
  const billamaApiKey = document.getElementById('billamaApiKey');
  const saveBillamaBtn = document.getElementById('saveBillamaBtn');
  const upstreamsList = document.getElementById('upstreamsList');
  const addUpstreamBtn = document.getElementById('addUpstreamBtn');
  const snippetBlock = document.getElementById('snippetBlock');
  const copySnippetBtn = document.getElementById('copySnippetBtn');
  const testPromptBtn = document.getElementById('testPromptBtn');
  const clearLogsBtn = document.getElementById('clearLogsBtn');
  const logsContainer = document.getElementById('logsContainer');
  const emptyLogs = document.getElementById('emptyLogs');

  let currentConfig = null;
  let serverEndpoint = 'https://127.0.0.1:3001/v1';

  async function init() {
    try {
      if (!api) {
        statusText.textContent = 'Standalone Mode (https://127.0.0.1:3001/v1)';
        return;
      }

      const status = await api.getServerStatus();
      if (status.status === 'running') {
        serverEndpoint = status.endpoint;
        statusText.textContent = `● Active: ${status.endpoint}`;
        snippetBlock.textContent = `export OPENAI_BASE_URL="${status.endpoint}"\nexport OPENAI_API_KEY="sk-eluvix-local"`;
      } else {
        statusText.textContent = 'Server Stopped';
      }

      currentConfig = await api.getConfig();
      if (currentConfig) {
        renderUpstreams(currentConfig.upstreams || []);
        
        // Find Billama upstream key
        const billama = currentConfig.upstreams.find(u => u.id === 'billama-cloud');
        if (billama && billama.apiKey) {
          billamaApiKey.value = billama.apiKey;
        }
      }

      // Listen for incoming request logs
      api.onRequestLogged((log) => {
        appendLogEntry(log);
      });

      // Initialize GPU provider controller
      await initProvider();
    } catch (err) {
      console.error('Initialization error:', err);
    }
  }

  function renderUpstreams(upstreams) {
    upstreamsList.innerHTML = '';
    upstreams.forEach((upstream, index) => {
      const item = document.createElement('div');
      item.className = 'upstream-item';

      item.innerHTML = `
        <div class="upstream-card-inner">
          <div class="upstream-header-row">
            <input type="text" class="edit-name" data-index="${index}" value="${escapeHtml(upstream.name)}" placeholder="Node Name" />
            <select class="edit-type" data-index="${index}">
              <option value="vllm" ${upstream.type === 'vllm' ? 'selected' : ''}>vLLM</option>
              <option value="vllm-sr" ${upstream.type === 'vllm-sr' ? 'selected' : ''}>vLLM-sr</option>
              <option value="ollama" ${upstream.type === 'ollama' ? 'selected' : ''}>Ollama</option>
              <option value="lemonade" ${upstream.type === 'lemonade' ? 'selected' : ''}>Lemonade</option>
              <option value="switchyard" ${upstream.type === 'switchyard' ? 'selected' : ''}>Switchyard</option>
              <option value="openai-compatible" ${upstream.type === 'openai-compatible' ? 'selected' : ''}>OpenAI-compatible</option>
              <option value="billama" ${upstream.type === 'billama' ? 'selected' : ''}>Billama</option>
            </select>
            <div class="header-right-controls">
              <label class="priority-label">
                Priority:
                <input type="number" class="edit-priority" data-index="${index}" value="${upstream.priority}" />
              </label>
              <button class="btn-delete" data-index="${index}" title="Remove Node">✕</button>
            </div>
          </div>

          <div class="field-group">
            <label class="field-label">Target Endpoint URL (Click to edit):</label>
            <input type="text" class="edit-endpoint" data-index="${index}" value="${escapeHtml(upstream.endpoint)}" placeholder="http://localhost:8000" />
          </div>

          <div class="field-group">
            <div class="models-header-row">
              <label class="field-label">Models (comma-separated, * for all):</label>
              <button class="btn-detect" data-index="${index}" title="Detect models from endpoint">🔍 Detect Models</button>
            </div>
            <input type="text" class="edit-models" data-index="${index}" value="${escapeHtml(upstream.models.join(', '))}" placeholder="meta-llama/Llama-3-8b, *" />
            <div class="detect-badge" id="detect-badge-${index}" style="display: none;"></div>
          </div>
        </div>
      `;
      upstreamsList.appendChild(item);
    });

    // Attach listeners to editable fields
    document.querySelectorAll('.edit-endpoint').forEach(input => {
      input.addEventListener('change', (e) => {
        const idx = parseInt(e.target.dataset.index);
        currentConfig.upstreams[idx].endpoint = e.target.value.trim();
        saveConfigDebounced();
      });
    });

    document.querySelectorAll('.edit-name').forEach(input => {
      input.addEventListener('change', (e) => {
        const idx = parseInt(e.target.dataset.index);
        currentConfig.upstreams[idx].name = e.target.value.trim();
        saveConfigDebounced();
      });
    });

    document.querySelectorAll('.edit-type').forEach(select => {
      select.addEventListener('change', (e) => {
        const idx = parseInt(e.target.dataset.index);
        currentConfig.upstreams[idx].type = e.target.value;
        saveConfigDebounced();
      });
    });

    document.querySelectorAll('.edit-priority').forEach(input => {
      input.addEventListener('change', (e) => {
        const idx = parseInt(e.target.dataset.index);
        currentConfig.upstreams[idx].priority = parseInt(e.target.value) || 0;
        saveConfigDebounced();
      });
    });

    document.querySelectorAll('.edit-models').forEach(input => {
      input.addEventListener('change', (e) => {
        const idx = parseInt(e.target.dataset.index);
        currentConfig.upstreams[idx].models = e.target.value.split(',').map(m => m.trim()).filter(Boolean);
        saveConfigDebounced();
      });
    });

    // Detect models handler per node
    document.querySelectorAll('.btn-detect').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const idx = parseInt(e.target.dataset.index);
        const upstream = currentConfig.upstreams[idx];
        const badge = document.getElementById(`detect-badge-${idx}`);
        const input = document.querySelector(`.edit-models[data-index="${idx}"]`);

        btn.disabled = true;
        btn.textContent = '⏳ Detecting...';
        if (badge) {
          badge.style.display = 'block';
          badge.className = 'detect-badge';
          badge.textContent = `Probing ${upstream.endpoint}...`;
        }

        try {
          const res = api && api.detectModels
            ? await api.detectModels({
                id: upstream.id,
                name: upstream.name,
                type: upstream.type,
                endpoint: upstream.endpoint,
                apiKey: upstream.apiKey
              })
            : await (await fetch(`${serverEndpoint.replace(/\/v1$/, '')}/api/detect-models`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  id: upstream.id,
                  name: upstream.name,
                  type: upstream.type,
                  endpoint: upstream.endpoint,
                  apiKey: upstream.apiKey
                })
              })).json();

          if (res && res.success && Array.isArray(res.models) && res.models.length > 0) {
            upstream.models = res.models;
            if (input) input.value = res.models.join(', ');
            saveConfigDebounced();
            if (badge) {
              badge.className = 'detect-badge success';
              badge.textContent = `✓ Detected ${res.models.length} model(s): ${res.models.slice(0, 3).join(', ')}${res.models.length > 3 ? '...' : ''}`;
            }
          } else {
            if (badge) {
              badge.className = 'detect-badge warning';
              badge.textContent = res?.message || `No models detected at ${upstream.endpoint} (server may be offline).`;
            }
          }
        } catch (err) {
          if (badge) {
            badge.className = 'detect-badge warning';
            badge.textContent = `Detection failed: ${err.message || 'Network error'}`;
          }
        } finally {
          btn.disabled = false;
          btn.textContent = '🔍 Detect Models';
        }
      });
    });

    document.querySelectorAll('.btn-delete').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const idx = parseInt(e.target.dataset.index);
        currentConfig.upstreams.splice(idx, 1);
        if (api) api.saveConfig(currentConfig);
        renderUpstreams(currentConfig.upstreams);
      });
    });
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  let saveTimeout = null;
  function saveConfigDebounced() {
    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => {
      if (api && currentConfig) {
        api.saveConfig(currentConfig);
        console.log('Eluvix configuration saved.');
      }
    }, 400);
  }

  function appendLogEntry(log) {
    if (emptyLogs) {
      emptyLogs.style.display = 'none';
    }

    const entry = document.createElement('div');
    entry.className = `log-entry status-${log.status}`;

    entry.innerHTML = `
      <div class="log-top-row">
        <span>POST /v1/chat/completions (${log.model})</span>
        <span>${log.status} ${log.status === 200 ? '✓' : '✗'}</span>
      </div>
      <div class="log-bottom-row">
        <span>Route: ${log.upstream} ${log.streaming ? '[Stream]' : ''}</span>
        <span>${log.durationMs}ms @ ${log.timestamp}</span>
      </div>
    `;

    logsContainer.prepend(entry);
  }

  // Event Handlers
  if (addUpstreamBtn) {
    addUpstreamBtn.addEventListener('click', () => {
      if (!currentConfig) return;
      const newNode = {
        id: `node-${Date.now()}`,
        name: 'New Custom Upstream',
        type: 'openai-compatible',
        endpoint: 'http://localhost:11434',
        priority: 10,
        models: ['*']
      };
      currentConfig.upstreams.push(newNode);
      if (api) api.saveConfig(currentConfig);
      renderUpstreams(currentConfig.upstreams);
    });
  }

  const detectAllBtn = document.getElementById('detectAllBtn');
  if (detectAllBtn) {
    detectAllBtn.addEventListener('click', async () => {
      if (!currentConfig) return;
      detectAllBtn.disabled = true;
      detectAllBtn.textContent = '⏳ Probing Nodes...';

      try {
        const res = api && api.detectModels
          ? await api.detectModels({ all: true })
          : await (await fetch(`${serverEndpoint.replace(/\/v1$/, '')}/api/detect-models`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ all: true })
            })).json();

        if (res && res.success && res.detected) {
          let totalCount = 0;
          currentConfig.upstreams.forEach(u => {
            const list = res.detected[u.id];
            if (list && list.length > 0) {
              u.models = list;
              totalCount += list.length;
            }
          });
          if (api) api.saveConfig(currentConfig);
          renderUpstreams(currentConfig.upstreams);
          alert(`Successfully probed local nodes! Detected ${totalCount} active model(s).`);
        } else {
          alert('No running local engines detected. Please make sure Ollama, vLLM, or Lemonade is active.');
        }
      } catch (err) {
        console.error('Batch detection failed:', err);
      } finally {
        detectAllBtn.disabled = false;
        detectAllBtn.textContent = '🔍 Detect All Models';
      }
    });
  }

  copyEndpointBtn.addEventListener('click', () => {
    if (api) {
      api.copyToClipboard(serverEndpoint);
    } else {
      navigator.clipboard.writeText(serverEndpoint);
    }
    copyEndpointBtn.textContent = 'Copied!';
    setTimeout(() => { copyEndpointBtn.textContent = 'Copy Base URL'; }, 1500);
  });

  const openEditorBtn = document.getElementById('openEditorBtn');
  if (openEditorBtn) {
    openEditorBtn.addEventListener('click', () => {
      const url = 'http://localhost:3000/editor';
      if (api && api.openExternal) {
        api.openExternal(url);
      } else {
        window.open(url, '_blank');
      }
    });
  }

  copySnippetBtn.addEventListener('click', () => {
    const text = snippetBlock.textContent;
    if (api) {
      api.copyToClipboard(text);
    } else {
      navigator.clipboard.writeText(text);
    }
    copySnippetBtn.textContent = 'Copied!';
    setTimeout(() => { copySnippetBtn.textContent = 'Copy Env Vars'; }, 1500);
  });

  saveBillamaBtn.addEventListener('click', async () => {
    const key = billamaApiKey.value.trim();
    if (!currentConfig) return;

    const billama = currentConfig.upstreams.find(u => u.id === 'billama-cloud' || u.type === 'billama');
    if (billama) {
      billama.apiKey = key;
      await api.saveConfig(currentConfig);
      saveBillamaBtn.textContent = 'Saved!';
      setTimeout(() => { saveBillamaBtn.textContent = 'Save Key'; }, 1500);
    }
  });

  clearLogsBtn.addEventListener('click', () => {
    logsContainer.innerHTML = '';
    if (emptyLogs) {
      emptyLogs.style.display = 'block';
      logsContainer.appendChild(emptyLogs);
    }
  });

  testPromptBtn.addEventListener('click', async () => {
    testPromptBtn.disabled = true;
    testPromptBtn.textContent = 'Routing...';

    try {
      const response = await fetch(`${serverEndpoint}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'meta-llama/Llama-3-8b',
          messages: [{ role: 'user', content: 'Ping from Eluvix Desktop' }],
          stream: false
        })
      });

      console.log('Test response status:', response.status);
    } catch (err) {
      console.error('Test prompt error:', err);
    } finally {
      testPromptBtn.disabled = false;
      testPromptBtn.textContent = '⚡ Send Test Request';
    }
  });

  // --- Provider Controller for GPU Monetization ---
  const providerNavBtn = document.getElementById('providerNavBtn');
  const providerCard = document.getElementById('providerCard');
  const providerToggleBtn = document.getElementById('providerToggleBtn');
  const providerBadge = document.getElementById('providerBadge');
  const providerBadgeText = document.getElementById('providerBadgeText');
  const providerEarnedVal = document.getElementById('providerEarnedVal');
  const providerTokensVal = document.getElementById('providerTokensVal');
  const providerGpuVal = document.getElementById('providerGpuVal');
  const providerTempVal = document.getElementById('providerTempVal');
  const providerReputationSub = document.getElementById('providerReputationSub');
  const providerJobsSub = document.getElementById('providerJobsSub');
  const providerVramSub = document.getElementById('providerVramSub');
  const providerBenchmarkBtn = document.getElementById('providerBenchmarkBtn');
  const providerSettingsToggleBtn = document.getElementById('providerSettingsToggleBtn');
  const providerSettingsPanel = document.getElementById('providerSettingsPanel');
  const providerNodeToken = document.getElementById('providerNodeToken');
  const providerEngineType = document.getElementById('providerEngineType');
  const providerEngineUrl = document.getElementById('providerEngineUrl');
  const providerPricingMode = document.getElementById('providerPricingMode');
  const providerPauseOnUser = document.getElementById('providerPauseOnUser');
  const providerSaveSettingsBtn = document.getElementById('providerSaveSettingsBtn');
  const providerSaveMsg = document.getElementById('providerSaveMsg');
  const providerJobsFeed = document.getElementById('providerJobsFeed');

  let currentProviderStatus = null;

  async function initProvider() {
    if (!api || !api.getProviderStatus) return;

    if (providerNavBtn && providerCard) {
      providerNavBtn.addEventListener('click', () => {
        providerCard.scrollIntoView({ behavior: 'smooth' });
        providerCard.style.outline = '2px solid #f59e0b';
        setTimeout(() => { providerCard.style.outline = 'none'; }, 1500);
      });
    }

    if (providerSettingsToggleBtn && providerSettingsPanel) {
      providerSettingsToggleBtn.addEventListener('click', () => {
        providerSettingsPanel.classList.toggle('hidden');
      });
    }

    if (providerToggleBtn) {
      providerToggleBtn.addEventListener('click', async () => {
        providerToggleBtn.disabled = true;
        const willEnable = currentProviderStatus?.status === 'OFFLINE' || currentProviderStatus?.status === 'ERROR';
        try {
          const res = await api.toggleProvider(willEnable);
          if (res && res.status) {
            updateProviderUI(res.status);
          }
        } catch (e) {
          console.error('Failed to toggle provider:', e);
        } finally {
          providerToggleBtn.disabled = false;
        }
      });
    }

    if (providerBenchmarkBtn) {
      providerBenchmarkBtn.addEventListener('click', async () => {
        providerBenchmarkBtn.disabled = true;
        providerBenchmarkBtn.textContent = 'Running...';
        try {
          const res = await api.runProviderBenchmark();
          if (res && res.success) {
            alert('✓ Benchmark completed! Token output verified and job logged.');
            if (res.status) updateProviderUI(res.status);
            refreshProviderJobs();
          } else {
            alert('Benchmark failed: ' + (res?.error || 'Unknown error'));
          }
        } catch (e) {
          alert('Benchmark error: ' + e.message);
        } finally {
          providerBenchmarkBtn.disabled = false;
          providerBenchmarkBtn.textContent = '🧪 Run Local Benchmark';
        }
      });
    }

    if (providerSaveSettingsBtn) {
      providerSaveSettingsBtn.addEventListener('click', async () => {
        providerSaveSettingsBtn.disabled = true;
        try {
          const config = {
            nodeToken: providerNodeToken.value.trim(),
            engineType: providerEngineType.value,
            engineUrl: providerEngineUrl.value.trim(),
            pricingMode: providerPricingMode.value,
            pauseOnUserActive: providerPauseOnUser.checked
          };
          const res = await api.saveProviderConfig(config);
          if (res && res.success) {
            providerSaveMsg.textContent = '✓ Saved!';
            setTimeout(() => { providerSaveMsg.textContent = ''; }, 2500);
          }
        } catch (e) {
          providerSaveMsg.textContent = 'Failed to save';
        } finally {
          providerSaveSettingsBtn.disabled = false;
        }
      });
    }

    // Load initial status
    try {
      const data = await api.getProviderStatus();
      if (data && data.success) {
        if (data.status) updateProviderUI(data.status);
        if (data.settings) {
          if (providerNodeToken) providerNodeToken.value = data.settings.node_token || '';
          if (providerEngineType) providerEngineType.value = data.settings.engine_type || 'ollama';
          if (providerEngineUrl) providerEngineUrl.value = data.settings.engine_url || 'http://localhost:11434';
          if (providerPricingMode) providerPricingMode.value = data.settings.pricing_mode || 'market';
          if (providerPauseOnUser) providerPauseOnUser.checked = Boolean(data.settings.pause_on_user_active ?? 1);
        }
        if (data.recentJobs && data.recentJobs.length > 0) {
          renderProviderJobs(data.recentJobs);
        }
      }
    } catch (e) {
      console.warn('Initial provider status lookup failed:', e);
    }

    // Subscribe to IPC events
    api.onProviderStatusChanged((status) => {
      updateProviderUI(status);
    });

    api.onProviderJobCompleted((_job) => {
      refreshProviderJobs();
    });

    // Periodic poll
    setInterval(async () => {
      try {
        const data = await api.getProviderStatus();
        if (data && data.success && data.status) {
          updateProviderUI(data.status);
        }
      } catch (_) {}
    }, 5000);
  }

  function updateProviderUI(status) {
    if (!status) return;
    currentProviderStatus = status;

    if (providerBadge && providerBadgeText) {
      providerBadge.className = 'provider-badge ' + status.status.toLowerCase();
      providerBadgeText.textContent = status.status;
    }

    if (providerToggleBtn) {
      if (status.status === 'ONLINE' || status.status === 'SERVING' || status.status === 'PAUSED') {
        providerToggleBtn.className = 'btn-stop-sharing';
        providerToggleBtn.textContent = '⏹ Stop Sharing';
      } else {
        providerToggleBtn.className = 'btn-start-sharing';
        providerToggleBtn.textContent = '▶ Start Sharing';
      }
    }

    if (providerEarnedVal) {
      providerEarnedVal.textContent = `$${(status.totalEarnedUsd || 0).toFixed(4)}`;
    }
    if (providerReputationSub) {
      providerReputationSub.textContent = `${status.reputationScore || 100}% Network Rep`;
    }
    if (providerTokensVal) {
      providerTokensVal.textContent = (status.totalTokensServed || 0).toLocaleString();
    }
    if (providerJobsSub) {
      providerJobsSub.textContent = `${status.totalJobsCompleted || 0} jobs completed`;
    }
    if (providerGpuVal) {
      providerGpuVal.textContent = status.gpu?.model || 'Generic Compute';
    }
    if (providerVramSub) {
      providerVramSub.textContent = `${status.gpu?.vramTotalGb || 0} GB VRAM`;
    }
    if (providerTempVal) {
      providerTempVal.textContent = `${status.gpu?.temperatureC || 42}°C`;
    }
  }

  async function refreshProviderJobs() {
    if (!api || !api.getProviderJobs) return;
    try {
      const res = await api.getProviderJobs(10);
      if (res && res.jobs) {
        renderProviderJobs(res.jobs);
      }
    } catch (_) {}
  }

  function renderProviderJobs(jobs) {
    if (!providerJobsFeed) return;
    if (!jobs || jobs.length === 0) {
      providerJobsFeed.innerHTML = '<div style="color: #64748b; font-size: 10px; font-style: italic;">No provider jobs executed yet.</div>';
      return;
    }

    let html = '<table class="provider-jobs-table"><thead><tr><th>Time</th><th>Model</th><th>Tokens</th><th>Duration</th><th>Earned</th></tr></thead><tbody>';
    jobs.slice(0, 5).forEach(j => {
      const tokens = (j.prompt_tokens || 0) + (j.completion_tokens || 0);
      const earned = (j.earned_usd || 0).toFixed(5);
      const time = j.timestamp ? new Date(j.timestamp).toLocaleTimeString() : 'now';
      html += `<tr><td>${time}</td><td>${escapeHtml(j.model)}</td><td>${tokens}</td><td>${j.duration_ms}ms</td><td style="color: #34d399;">+$${earned}</td></tr>`;
    });
    html += '</tbody></table>';
    providerJobsFeed.innerHTML = html;
  }

  init();
})();
