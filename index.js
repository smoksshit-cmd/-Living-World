/**
 * Living World Extension for SillyTavern
 * Adds autonomous NPCs, random encounters, offscreen character life
 * Version: 1.0.0
 */

import {
    getContext,
    extension_settings,
    saveSettingsDebounced,
    renderExtensionTemplateAsync,
} from '../../../extensions.js';

import {
    eventSource,
    event_types,
    substituteParams,
    chat,
    characters,
    this_chid,
    generateQuietPrompt,
} from '../../../../script.js';

import { getWorldInfoPrompt, world_info } from '../../../world-info.js';

const EXT_NAME = 'living-world';

// ─── Default Settings ────────────────────────────────────────────────────────

const defaultSettings = {
    enabled: true,

    // NPC Encounter settings
    encounter_enabled: true,
    encounter_chance: 25,           // % chance per trigger
    encounter_interval: 5,          // every N messages
    encounter_message_counter: 0,

    // Name settings
    name_language: 'english',       // 'russian', 'english', 'mixed'
    name_gender: 'random',          // 'male', 'female', 'random'

    // NPC weight distribution
    weight_passing: 60,
    weight_hook: 30,
    weight_important: 10,

    // Auto-detect location
    auto_location: true,
    manual_location: '',

    // Save NPCs to lorebook
    save_to_lorebook: true,
    lorebook_name: 'Living World NPCs',

    // Character autonomy
    autonomy_enabled: true,
    autonomy_interval: 8,           // every N messages
    autonomy_message_counter: 0,

    // Knowledge separation
    knowledge_separation: true,

    // Offscreen log
    offscreen_enabled: true,
    offscreen_interval: 10,
    offscreen_message_counter: 0,

    // NPC registry (saved NPCs this session)
    npc_registry: [],
};

// ─── Name Banks ──────────────────────────────────────────────────────────────

const NAMES = {
    russian: {
        male: ['Алексей', 'Дмитрий', 'Иван', 'Михаил', 'Николай', 'Пётр', 'Сергей', 'Андрей', 'Владимир', 'Фёдор', 'Григорий', 'Тимофей', 'Аркадий', 'Борис', 'Виктор', 'Евгений', 'Константин', 'Леонид', 'Олег', 'Павел'],
        female: ['Анна', 'Мария', 'Елена', 'Ольга', 'Татьяна', 'Наталья', 'Ирина', 'Светлана', 'Людмила', 'Екатерина', 'Александра', 'Вера', 'Надежда', 'Любовь', 'Галина', 'Зинаида', 'Тамара', 'Валентина', 'Юлия', 'Ксения'],
    },
    english: {
        male: ['Arthur', 'Edmund', 'Roland', 'Thomas', 'William', 'Henry', 'James', 'Robert', 'Edward', 'Geoffrey', 'Marcus', 'Leon', 'Dorian', 'Felix', 'Gareth', 'Hugo', 'Ivan', 'Kane', 'Leander', 'Miles'],
        female: ['Eleanor', 'Isolde', 'Marian', 'Vivienne', 'Clara', 'Beatrice', 'Diana', 'Elspeth', 'Flora', 'Grace', 'Helena', 'Iris', 'Juliet', 'Lyra', 'Miriam', 'Nora', 'Ophelia', 'Petra', 'Rosalind', 'Sylvia'],
    },
};

const SURNAMES = {
    russian: ['Волков', 'Кузнецов', 'Смирнов', 'Попов', 'Соколов', 'Лебедев', 'Козлов', 'Новиков', 'Морозов', 'Петров', 'Волкова', 'Кузнецова', 'Смирнова'],
    english: ['Blackwood', 'Crane', 'Dusk', 'Everett', 'Fairchild', 'Gale', 'Harrow', 'Irving', 'Jarvis', 'Kent', 'Lorne', 'Marsh', 'Nightingale', 'Ashford', 'Bramble'],
};

// ─── Utility ─────────────────────────────────────────────────────────────────

function rand(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pickRandom(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

function rollChance(percent) {
    return Math.random() * 100 < percent;
}

function getSettings() {
    extension_settings[EXT_NAME] = extension_settings[EXT_NAME] || {};
    return Object.assign({}, defaultSettings, extension_settings[EXT_NAME]);
}

function saveSettings(updates) {
    extension_settings[EXT_NAME] = Object.assign(getSettings(), updates);
    saveSettingsDebounced();
}

// ─── Name Generation ─────────────────────────────────────────────────────────

function generateNpcName(settings) {
    const lang = settings.name_language;
    let gender = settings.name_gender;

    if (gender === 'random') {
        gender = rollChance(50) ? 'male' : 'female';
    }

    // mixed: pick language randomly
    const activeLang = lang === 'mixed' ? (rollChance(50) ? 'russian' : 'english') : lang;
    const pool = NAMES[activeLang]?.[gender] || NAMES.english[gender];
    const surnamePool = SURNAMES[activeLang] || SURNAMES.english;

    const firstName = pickRandom(pool);
    const lastName = pickRandom(surnamePool);

    return { name: `${firstName} ${lastName}`, gender, lang: activeLang };
}

// ─── NPC Weight Roll ─────────────────────────────────────────────────────────

function rollNpcWeight(settings) {
    const roll = rand(1, 100);
    const passing = settings.weight_passing;
    const hook = settings.weight_hook;
    if (roll <= passing) return 'passing';
    if (roll <= passing + hook) return 'hook';
    return 'important';
}

const WEIGHT_LABELS = {
    passing: 'проходной персонаж (оживляет сцену, уходит)',
    hook: 'персонаж с зацепкой (приносит информацию или конфликт)',
    important: 'значимый персонаж (может стать частью сюжета)',
};

// ─── Location Parsing ─────────────────────────────────────────────────────────

function detectLocation(settings) {
    if (!settings.auto_location) return settings.manual_location || 'неизвестное место';

    const ctx = getContext();
    const lastMessages = (ctx.chat || []).slice(-5).map(m => m.mes || '').join(' ');

    const locationKeywords = {
        'таверна|tavern|inn|трактир': 'таверна',
        'улица|street|переулок|alley|площадь|square': 'улица',
        'лес|forest|woods|чаща': 'лес',
        'дворец|palace|замок|castle|throne': 'дворец',
        'рынок|market|bazaar|торг': 'рынок',
        'порт|harbor|dock|причал': 'порт',
        'temple|храм|church|церковь': 'храм',
        'dungeon|подземелье|тюрьма|prison': 'подземелье',
        'дом|house|home|комната|room|bedroom': 'дом',
    };

    for (const [pattern, label] of Object.entries(locationKeywords)) {
        if (new RegExp(pattern, 'i').test(lastMessages)) return label;
    }

    return settings.manual_location || 'общественное место';
}

// ─── Main NPC Generation ─────────────────────────────────────────────────────

async function generateRandomNpc() {
    const settings = getSettings();
    const ctx = getContext();

    if (!ctx.characterId && this_chid === undefined) {
        console.log('[LivingWorld] No active character, skipping NPC generation');
        return;
    }

    const charName = ctx.name2 || 'персонаж';
    const userName = ctx.name1 || 'игрок';
    const location = detectLocation(settings);
    const { name, gender, lang } = generateNpcName(settings);
    const weight = rollNpcWeight(settings);
    const weightLabel = WEIGHT_LABELS[weight];
    const genderRu = gender === 'male' ? 'мужчина' : 'женщина';

    const prompt = `Ты генератор персонажей для ролевой игры. Создай НПС для сцены.

Локация: ${location}
Имя: ${name} (пол: ${genderRu})
Тип персонажа: ${weightLabel}
Основной персонаж сцены: ${charName}
Игрок: ${userName}

Требования:
- Персонаж появляется по своим собственным делам, НЕ из-за игрока
- Персонаж НЕ знает о личных делах игрока или ${charName} заранее
- Дай короткое описание внешности (1-2 предложения)
- Дай краткую причину появления (1 предложение)
- Если тип "с зацепкой" или "значимый" — дай 1 зацепку/секрет/цель персонажа
- Ответь ТОЛЬКО в формате JSON без markdown:
{
  "name": "...",
  "gender": "male/female",
  "appearance": "...",
  "reason": "...",
  "hook": "...",
  "weight": "${weight}"
}`;

    try {
        showNotification('🎲 Генерирую случайного НПС...', 'info');
        const response = await generateQuietPrompt(prompt, false, false, '', 400, true);

        let npcData;
        try {
            const clean = response.replace(/```json|```/g, '').trim();
            npcData = JSON.parse(clean);
        } catch {
            // fallback: construct minimal object
            npcData = {
                name,
                gender,
                appearance: response.slice(0, 150),
                reason: 'появился по своим делам',
                hook: '',
                weight,
            };
        }

        npcData.name = npcData.name || name;
        npcData.location = location;
        npcData.timestamp = Date.now();

        // Save to registry
        const registry = settings.npc_registry || [];
        registry.push(npcData);
        saveSettings({ npc_registry: registry });

        // Inject into scene
        await injectNpcIntoScene(npcData, charName);

        // Save to lorebook if enabled
        if (settings.save_to_lorebook) {
            await saveNpcToLorebook(npcData);
        }

        updateNpcRegistryUI();

    } catch (err) {
        console.error('[LivingWorld] NPC generation failed:', err);
        showNotification('⚠️ Ошибка генерации НПС', 'error');
    }
}

async function injectNpcIntoScene(npc, charName) {
    const ctx = getContext();
    const genderRu = npc.gender === 'male' ? 'он' : 'она';

    let injection = `[МИРОВОЕ СОБЫТИЕ: Появляется ${npc.name} — ${npc.appearance} ${npc.reason}.`;
    if (npc.hook) {
        injection += ` ${npc.hook}`;
    }
    injection += `]`;

    // Add as narrator system message in chat
    const systemMsg = {
        name: 'Нарратор',
        is_user: false,
        is_system: true,
        send_date: new Date().toISOString(),
        mes: injection,
        extra: { type: 'living_world_npc', npc_data: npc },
    };

    ctx.chat.push(systemMsg);
    await ctx.saveChat();

    // Refresh chat display
    if (typeof ctx.printMessages === 'function') {
        ctx.printMessages();
    } else {
        // Fallback: add message to DOM
        addMessageToChat(systemMsg);
    }

    showNotification(`✨ НПС появился: ${npc.name}`, 'success');
}

function addMessageToChat(msg) {
    const chatContainer = document.getElementById('chat');
    if (!chatContainer) return;

    const div = document.createElement('div');
    div.className = 'mes living-world-npc-msg';
    div.style.cssText = 'background: rgba(100,60,160,0.15); border-left: 3px solid #8b5cf6; padding: 8px 12px; margin: 6px 0; border-radius: 4px; font-style: italic; color: #c4b5fd;';
    div.innerHTML = `<span style="font-size:0.8em;opacity:0.7">🌍 Мировое событие</span><br>${escapeHtml(msg.mes)}`;
    chatContainer.appendChild(div);
    chatContainer.scrollTop = chatContainer.scrollHeight;
}

function escapeHtml(str) {
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ─── Lorebook Integration ─────────────────────────────────────────────────────

async function saveNpcToLorebook(npc) {
    try {
        const ctx = getContext();
        // Try to find or create the lorebook
        let lbName = getSettings().lorebook_name;

        const entry = {
            key: [npc.name, npc.name.split(' ')[0]],
            content: `[НПС: ${npc.name}] Пол: ${npc.gender === 'male' ? 'муж' : 'жен'}. Внешность: ${npc.appearance} Появился в: ${npc.location}. ${npc.hook ? 'Зацепка: ' + npc.hook : ''}`,
            comment: `Living World NPC — ${new Date(npc.timestamp).toLocaleDateString()}`,
            selective: false,
            constant: false,
            order: 100,
            position: 'before_char',
            disable: false,
        };

        // Use ST's world info API if available
        if (typeof ctx.setWorldInfoEntry === 'function') {
            await ctx.setWorldInfoEntry(lbName, entry);
        } else {
            // Fallback: store in settings
            console.log('[LivingWorld] Lorebook API not available, storing in settings only');
        }

        console.log(`[LivingWorld] Saved NPC "${npc.name}" to lorebook`);
    } catch (err) {
        console.error('[LivingWorld] Failed to save to lorebook:', err);
    }
}

// ─── Character Autonomy ───────────────────────────────────────────────────────

async function triggerCharacterAutonomy() {
    const settings = getSettings();
    const ctx = getContext();

    if (!ctx.characterId && this_chid === undefined) return;

    const charName = ctx.name2 || 'персонаж';
    const userName = ctx.name1 || 'игрок';

    const recentChat = (ctx.chat || []).slice(-3).map(m => `${m.name}: ${m.mes}`).join('\n');

    const prompt = `Ты описываешь внутреннее состояние персонажа в ролевой игре.

Персонаж: ${charName}
Игрок: ${userName}

Последние события:
${recentChat}

Напиши ОДНО короткое действие или мысль ${charName}, который сейчас занят своими собственными делами, независимо от ${userName}. Это может быть:
- что-то что ${charName} делает параллельно
- мимолётная мысль о своих планах/заботах
- небольшое личное действие

2-3 предложения максимум. Пиши от третьего лица. НЕ обращайся к игроку.`;

    try {
        const response = await generateQuietPrompt(prompt, false, false, '', 200, true);
        if (!response || response.trim().length < 10) return;

        const autonomyMsg = {
            name: 'Нарратор',
            is_user: false,
            is_system: true,
            send_date: new Date().toISOString(),
            mes: `[${charName} — фоновое действие] ${response.trim()}`,
            extra: { type: 'living_world_autonomy' },
        };

        ctx.chat.push(autonomyMsg);
        await ctx.saveChat();
        addAutonomyMessageToChat(autonomyMsg, charName);

    } catch (err) {
        console.error('[LivingWorld] Autonomy tick failed:', err);
    }
}

function addAutonomyMessageToChat(msg, charName) {
    const chatContainer = document.getElementById('chat');
    if (!chatContainer) return;

    const div = document.createElement('div');
    div.className = 'mes living-world-autonomy-msg';
    div.style.cssText = 'background: rgba(30,100,60,0.12); border-left: 3px solid #34d399; padding: 8px 12px; margin: 6px 0; border-radius: 4px; font-style: italic; color: #6ee7b7; font-size: 0.92em;';
    div.innerHTML = `<span style="font-size:0.75em;opacity:0.7">🌿 ${escapeHtml(charName)}</span><br>${escapeHtml(msg.mes.replace(/^\[.*?\]\s*/, ''))}`;
    chatContainer.appendChild(div);
    chatContainer.scrollTop = chatContainer.scrollHeight;
}

// ─── Offscreen Log ────────────────────────────────────────────────────────────

async function triggerOffscreenLog() {
    const settings = getSettings();
    const ctx = getContext();

    if (!ctx.characterId && this_chid === undefined) return;

    const charName = ctx.name2 || 'персонаж';
    const recentNpcs = (settings.npc_registry || []).slice(-3).map(n => n.name).join(', ');

    const prompt = `Ты ведёшь хронику мира для ролевой игры. 

Персонаж: ${charName}
${recentNpcs ? `Недавние НПС в мире: ${recentNpcs}` : ''}

Опиши 2-3 вещи которые произошли В МИРЕ (не в основной сцене) за последнее время. ${charName} не знает об этих событиях, если игрок не сообщил ему.

Это фоновые события: слухи, дела НПС, изменения в мире. Пиши кратко, каждое событие одним предложением. Без нумерации.`;

    try {
        const response = await generateQuietPrompt(prompt, false, false, '', 250, true);
        if (!response || response.trim().length < 20) return;

        // Store in settings as world log
        const log = settings.world_log || [];
        log.push({
            timestamp: Date.now(),
            events: response.trim(),
        });
        // Keep last 20 entries
        saveSettings({ world_log: log.slice(-20) });

        updateWorldLogUI(response.trim());
        showNotification('📜 Хроника мира обновлена', 'info');

    } catch (err) {
        console.error('[LivingWorld] Offscreen log failed:', err);
    }
}

// ─── Knowledge Separation ─────────────────────────────────────────────────────

function getKnowledgeSeparationPrompt() {
    const ctx = getContext();
    const charName = ctx.name2 || 'персонаж';
    const userName = ctx.name1 || 'игрок';

    return `[СИСТЕМНОЕ ПРАВИЛО МИРА: ${charName} обладает только той информацией, которую получил лично или через прямое общение. Он не знает о событиях, в которых не участвовал, и не может телепатически чувствовать состояние ${userName}. ${charName} живёт своей жизнью: у него есть цели, заботы и дела, не связанные с ${userName}.]`;
}

// ─── Message Counter & Triggers ──────────────────────────────────────────────

async function onMessageReceived() {
    const settings = getSettings();
    if (!settings.enabled) return;

    let encounterCounter = (settings.encounter_message_counter || 0) + 1;
    let autonomyCounter = (settings.autonomy_message_counter || 0) + 1;
    let offscreenCounter = (settings.offscreen_message_counter || 0) + 1;

    const updates = {
        encounter_message_counter: encounterCounter,
        autonomy_message_counter: autonomyCounter,
        offscreen_message_counter: offscreenCounter,
    };

    // Check NPC encounter
    if (settings.encounter_enabled && encounterCounter >= settings.encounter_interval) {
        updates.encounter_message_counter = 0;
        if (rollChance(settings.encounter_chance)) {
            setTimeout(() => generateRandomNpc(), 800);
        }
    }

    // Check autonomy tick
    if (settings.autonomy_enabled && autonomyCounter >= settings.autonomy_interval) {
        updates.autonomy_message_counter = 0;
        setTimeout(() => triggerCharacterAutonomy(), 1500);
    }

    // Check offscreen log
    if (settings.offscreen_enabled && offscreenCounter >= settings.offscreen_interval) {
        updates.offscreen_message_counter = 0;
        setTimeout(() => triggerOffscreenLog(), 2000);
    }

    saveSettings(updates);
}

// Inject knowledge separation into prompt
function onPromptReady(event) {
    const settings = getSettings();
    if (!settings.enabled || !settings.knowledge_separation) return;

    const prompt = event?.detail?.chat;
    if (!prompt) return;

    const injection = getKnowledgeSeparationPrompt();
    // Inject after system prompt if possible
    if (Array.isArray(prompt)) {
        const sysIdx = prompt.findIndex(m => m.role === 'system');
        if (sysIdx !== -1) {
            prompt[sysIdx].content += '\n\n' + injection;
        }
    }
}

// ─── Notifications ────────────────────────────────────────────────────────────

function showNotification(message, type = 'info') {
    // Use ST's toastr if available
    if (typeof toastr !== 'undefined') {
        const method = type === 'error' ? 'error' : type === 'success' ? 'success' : 'info';
        toastr[method](message, 'Living World', { timeOut: 3000, positionClass: 'toast-bottom-right' });
    } else {
        console.log(`[LivingWorld] ${type.toUpperCase()}: ${message}`);
    }
}

// ─── UI Updates ───────────────────────────────────────────────────────────────

function updateNpcRegistryUI() {
    const settings = getSettings();
    const container = document.getElementById('lw-npc-registry');
    if (!container) return;

    const registry = settings.npc_registry || [];
    if (registry.length === 0) {
        container.innerHTML = '<p style="opacity:0.5;font-style:italic">Пока нет сгенерированных НПС</p>';
        return;
    }

    container.innerHTML = registry.slice(-10).reverse().map(npc => `
        <div style="background:rgba(255,255,255,0.05);border-radius:6px;padding:8px 10px;margin-bottom:6px;">
            <strong>${escapeHtml(npc.name)}</strong>
            <span style="opacity:0.6;font-size:0.8em;margin-left:8px">${npc.gender === 'male' ? '♂' : '♀'} · ${escapeHtml(npc.location || '?')} · ${npc.weight || '?'}</span>
            <div style="font-size:0.85em;opacity:0.8;margin-top:2px">${escapeHtml((npc.appearance || '').slice(0, 80))}...</div>
        </div>
    `).join('');
}

function updateWorldLogUI(events) {
    const container = document.getElementById('lw-world-log');
    if (!container) return;

    const entry = document.createElement('div');
    entry.style.cssText = 'border-left:2px solid #6366f1;padding:6px 10px;margin-bottom:8px;font-size:0.85em;opacity:0.85';
    entry.innerHTML = `<span style="opacity:0.5;font-size:0.75em">${new Date().toLocaleTimeString()}</span><br>${escapeHtml(events)}`;
    container.insertBefore(entry, container.firstChild);

    // Cap at 10 entries in UI
    while (container.children.length > 10) container.lastChild.remove();
}

// ─── Settings Panel ───────────────────────────────────────────────────────────

function buildSettingsHTML() {
    const s = getSettings();

    return `
<div id="living-world-settings" style="font-family:var(--mainFontFamily,sans-serif);color:var(--SmartThemeBodyColor,#ccc);padding:4px;">

  <!-- Master toggle -->
  <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;">
    <label style="font-size:1.1em;font-weight:600">🌍 Living World</label>
    <label class="checkbox_label" style="margin-left:auto;">
      <input type="checkbox" id="lw-enabled" ${s.enabled ? 'checked' : ''}>
      <span>Включено</span>
    </label>
  </div>

  <!-- Tabs -->
  <div style="display:flex;gap:4px;margin-bottom:12px;">
    ${['encounters','autonomy','names','world','log'].map((tab,i) => `
      <button class="lw-tab menu_button" data-tab="${tab}" style="padding:4px 10px;font-size:0.82em;${i===0?'background:var(--SmartThemeQuoteColor,#6366f1);color:#fff;':''}">${
        {encounters:'⚔️ Встречи', autonomy:'🌿 Автономия', names:'📛 Имена', world:'🗺️ Мир', log:'📜 Лог'}[tab]
      }</button>
    `).join('')}
  </div>

  <!-- Tab: Encounters -->
  <div class="lw-tab-content" id="lw-tab-encounters">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
      <input type="checkbox" id="lw-encounter-enabled" ${s.encounter_enabled ? 'checked':''}>
      <label for="lw-encounter-enabled">Случайные встречи</label>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px;">
      <label>Шанс появления НПС: <b id="lw-chance-val">${s.encounter_chance}%</b>
        <input type="range" id="lw-encounter-chance" min="5" max="100" step="5" value="${s.encounter_chance}" style="width:100%">
      </label>
      <label>Каждые N сообщений: <b id="lw-interval-val">${s.encounter_interval}</b>
        <input type="range" id="lw-encounter-interval" min="1" max="20" step="1" value="${s.encounter_interval}" style="width:100%">
      </label>
    </div>

    <p style="font-size:0.82em;margin-bottom:6px;">Вес типов НПС (сумма = 100%):</p>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:10px;">
      <label>Проходной <b id="lw-w-pass-val">${s.weight_passing}%</b>
        <input type="range" id="lw-weight-passing" min="0" max="100" step="5" value="${s.weight_passing}" style="width:100%">
      </label>
      <label>С зацепкой <b id="lw-w-hook-val">${s.weight_hook}%</b>
        <input type="range" id="lw-weight-hook" min="0" max="100" step="5" value="${s.weight_hook}" style="width:100%">
      </label>
      <label>Важный <b id="lw-w-imp-val">${s.weight_important}%</b>
        <input type="range" id="lw-weight-important" min="0" max="100" step="5" value="${s.weight_important}" style="width:100%">
      </label>
    </div>

    <div style="margin-bottom:8px;">
      <label>
        <input type="checkbox" id="lw-auto-location" ${s.auto_location?'checked':''}>
        Автоопределение локации
      </label>
    </div>
    <div>
      <label>Ручная локация (если авто выключено):
        <input type="text" id="lw-manual-location" value="${escapeHtml(s.manual_location)}" placeholder="таверна, улица, лес..." style="width:100%;margin-top:4px;padding:4px 8px;background:var(--SmartThemeChatTintColor,#1a1a2e);border:1px solid rgba(255,255,255,0.15);border-radius:4px;color:inherit;">
      </label>
    </div>

    <div style="margin-top:10px;">
      <label>
        <input type="checkbox" id="lw-save-lorebook" ${s.save_to_lorebook?'checked':''}>
        Сохранять НПС в лорбук "<span id="lw-lb-name-display">${escapeHtml(s.lorebook_name)}</span>"
      </label>
    </div>

    <button id="lw-force-npc" class="menu_button" style="margin-top:12px;width:100%;padding:8px;">
      🎲 Сгенерировать НПС прямо сейчас
    </button>
  </div>

  <!-- Tab: Autonomy -->
  <div class="lw-tab-content" id="lw-tab-autonomy" style="display:none">
    <div style="margin-bottom:8px;">
      <input type="checkbox" id="lw-autonomy-enabled" ${s.autonomy_enabled?'checked':''}>
      <label for="lw-autonomy-enabled">Фоновые действия персонажа</label>
      <p style="font-size:0.82em;opacity:0.7;margin:4px 0 0 20px">Персонаж иногда делает что-то своё, независимо от игрока</p>
    </div>
    <label>Каждые N сообщений: <b id="lw-aut-int-val">${s.autonomy_interval}</b>
      <input type="range" id="lw-autonomy-interval" min="3" max="30" step="1" value="${s.autonomy_interval}" style="width:100%;margin-top:4px;">
    </label>

    <div style="margin-top:14px;">
      <input type="checkbox" id="lw-knowledge-sep" ${s.knowledge_separation?'checked':''}>
      <label for="lw-knowledge-sep">Разделение знаний</label>
      <p style="font-size:0.82em;opacity:0.7;margin:4px 0 0 20px">Персонаж не знает то, чего не видел сам</p>
    </div>

    <div style="margin-top:14px;">
      <input type="checkbox" id="lw-offscreen-enabled" ${s.offscreen_enabled?'checked':''}>
      <label for="lw-offscreen-enabled">Фоновая хроника мира</label>
      <p style="font-size:0.82em;opacity:0.7;margin:4px 0 0 20px">Периодически генерирует события "за кадром"</p>
    </div>
    <label style="display:${s.offscreen_enabled?'block':'none'}" id="lw-offscreen-interval-wrap">
      Хроника каждые N сообщений: <b id="lw-off-int-val">${s.offscreen_interval}</b>
      <input type="range" id="lw-offscreen-interval" min="5" max="30" step="1" value="${s.offscreen_interval}" style="width:100%;margin-top:4px;">
    </label>
  </div>

  <!-- Tab: Names -->
  <div class="lw-tab-content" id="lw-tab-names" style="display:none">
    <div style="margin-bottom:12px;">
      <p style="margin-bottom:6px;font-size:0.9em;">Язык имён НПС:</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        ${[['english','🇬🇧 Английские'],['russian','🇷🇺 Русские'],['mixed','🌐 Смешанные']].map(([val,lbl])=>`
          <label style="display:flex;align-items:center;gap:5px;cursor:pointer;">
            <input type="radio" name="lw-name-lang" value="${val}" ${s.name_language===val?'checked':''}>
            ${lbl}
          </label>
        `).join('')}
      </div>
    </div>

    <div>
      <p style="margin-bottom:6px;font-size:0.9em;">Пол НПС по умолчанию:</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        ${[['random','🎲 50/50'],['male','♂ Мужской'],['female','♀ Женский']].map(([val,lbl])=>`
          <label style="display:flex;align-items:center;gap:5px;cursor:pointer;">
            <input type="radio" name="lw-name-gender" value="${val}" ${s.name_gender===val?'checked':''}>
            ${lbl}
          </label>
        `).join('')}
      </div>
    </div>

    <div style="margin-top:16px;padding:10px;background:rgba(255,255,255,0.05);border-radius:6px;">
      <p style="font-size:0.82em;opacity:0.7;margin-bottom:8px;">Предпросмотр имён:</p>
      <div id="lw-name-preview" style="display:flex;flex-wrap:wrap;gap:6px;"></div>
      <button id="lw-refresh-names" class="menu_button" style="margin-top:8px;padding:4px 12px;font-size:0.82em;">🔄 Обновить</button>
    </div>
  </div>

  <!-- Tab: World -->
  <div class="lw-tab-content" id="lw-tab-world" style="display:none">
    <p style="font-size:0.85em;opacity:0.8;margin-bottom:10px;">Реестр НПС этой сессии:</p>
    <div id="lw-npc-registry">
      <p style="opacity:0.5;font-style:italic">Пока нет сгенерированных НПС</p>
    </div>
    <button id="lw-clear-registry" class="menu_button" style="margin-top:8px;padding:4px 12px;font-size:0.82em;color:#f87171;">
      🗑️ Очистить реестр
    </button>
  </div>

  <!-- Tab: Log -->
  <div class="lw-tab-content" id="lw-tab-log" style="display:none">
    <p style="font-size:0.85em;opacity:0.8;margin-bottom:10px;">Хроника мира (последние события):</p>
    <div id="lw-world-log">
      <p style="opacity:0.5;font-style:italic">Хроника пуста</p>
    </div>
    <button id="lw-force-log" class="menu_button" style="margin-top:8px;padding:4px 12px;font-size:0.82em;">
      📜 Обновить хронику сейчас
    </button>
  </div>

</div>
    `;
}

// ─── Event Listeners Setup ────────────────────────────────────────────────────

function setupUIListeners() {
    const root = document.getElementById('living-world-settings');
    if (!root) return;

    // Tab switching
    root.querySelectorAll('.lw-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            root.querySelectorAll('.lw-tab').forEach(b => b.style.background = '');
            root.querySelectorAll('.lw-tab-content').forEach(c => c.style.display = 'none');
            btn.style.background = 'var(--SmartThemeQuoteColor,#6366f1)';
            btn.style.color = '#fff';
            const target = document.getElementById(`lw-tab-${btn.dataset.tab}`);
            if (target) target.style.display = 'block';
        });
    });

    // Range sliders
    const sliders = [
        ['lw-encounter-chance', 'lw-chance-val', v => `${v}%`, 'encounter_chance'],
        ['lw-encounter-interval', 'lw-interval-val', v => v, 'encounter_interval'],
        ['lw-weight-passing', 'lw-w-pass-val', v => `${v}%`, 'weight_passing'],
        ['lw-weight-hook', 'lw-w-hook-val', v => `${v}%`, 'weight_hook'],
        ['lw-weight-important', 'lw-w-imp-val', v => `${v}%`, 'weight_important'],
        ['lw-autonomy-interval', 'lw-aut-int-val', v => v, 'autonomy_interval'],
        ['lw-offscreen-interval', 'lw-off-int-val', v => v, 'offscreen_interval'],
    ];

    sliders.forEach(([inputId, displayId, fmt, key]) => {
        const input = document.getElementById(inputId);
        const display = document.getElementById(displayId);
        if (!input) return;
        input.addEventListener('input', () => {
            const val = parseInt(input.value);
            if (display) display.textContent = fmt(val);
            saveSettings({ [key]: val });
        });
    });

    // Checkboxes
    const checkboxes = [
        ['lw-enabled', 'enabled'],
        ['lw-encounter-enabled', 'encounter_enabled'],
        ['lw-auto-location', 'auto_location'],
        ['lw-save-lorebook', 'save_to_lorebook'],
        ['lw-autonomy-enabled', 'autonomy_enabled'],
        ['lw-knowledge-sep', 'knowledge_separation'],
        ['lw-offscreen-enabled', 'offscreen_enabled'],
    ];

    checkboxes.forEach(([id, key]) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener('change', () => {
            saveSettings({ [key]: el.checked });
            if (id === 'lw-offscreen-enabled') {
                const wrap = document.getElementById('lw-offscreen-interval-wrap');
                if (wrap) wrap.style.display = el.checked ? 'block' : 'none';
            }
        });
    });

    // Text inputs
    const textInput = document.getElementById('lw-manual-location');
    if (textInput) {
        textInput.addEventListener('input', () => saveSettings({ manual_location: textInput.value }));
    }

    // Radio buttons
    root.querySelectorAll('input[name="lw-name-lang"]').forEach(radio => {
        radio.addEventListener('change', () => {
            saveSettings({ name_language: radio.value });
            refreshNamePreview();
        });
    });

    root.querySelectorAll('input[name="lw-name-gender"]').forEach(radio => {
        radio.addEventListener('change', () => {
            saveSettings({ name_gender: radio.value });
            refreshNamePreview();
        });
    });

    // Buttons
    document.getElementById('lw-force-npc')?.addEventListener('click', generateRandomNpc);
    document.getElementById('lw-force-log')?.addEventListener('click', triggerOffscreenLog);
    document.getElementById('lw-refresh-names')?.addEventListener('click', refreshNamePreview);

    document.getElementById('lw-clear-registry')?.addEventListener('click', () => {
        if (confirm('Очистить реестр НПС?')) {
            saveSettings({ npc_registry: [] });
            updateNpcRegistryUI();
        }
    });

    // Init
    refreshNamePreview();
    updateNpcRegistryUI();
}

function refreshNamePreview() {
    const container = document.getElementById('lw-name-preview');
    if (!container) return;

    const settings = getSettings();
    const names = [];
    for (let i = 0; i < 8; i++) {
        const { name, gender } = generateNpcName(settings);
        names.push({ name, gender });
    }

    container.innerHTML = names.map(({ name, gender }) => `
        <span style="background:rgba(255,255,255,0.08);padding:3px 8px;border-radius:12px;font-size:0.85em;">
            ${gender === 'male' ? '♂' : '♀'} ${escapeHtml(name)}
        </span>
    `).join('');
}

// ─── Extension Initialization ─────────────────────────────────────────────────

async function init() {
    console.log('[LivingWorld] Initializing...');

    // Initialize settings
    if (!extension_settings[EXT_NAME]) {
        extension_settings[EXT_NAME] = { ...defaultSettings };
        saveSettingsDebounced();
    }

    // Inject settings panel into ST sidebar
    const settingsPanel = document.getElementById('extensions_settings');
    if (settingsPanel) {
        const wrapper = document.createElement('div');
        wrapper.id = 'living-world-extension';
        wrapper.innerHTML = buildSettingsHTML();

        // Add collapsible header like other ST extensions
        const details = document.createElement('details');
        const summary = document.createElement('summary');
        summary.innerHTML = '🌍 Living World';
        summary.style.cssText = 'cursor:pointer;padding:8px 0;font-weight:600;list-style:none;user-select:none;';
        details.appendChild(summary);
        details.appendChild(wrapper);
        details.style.cssText = 'border-bottom:1px solid rgba(255,255,255,0.1);padding-bottom:12px;margin-bottom:8px;';

        settingsPanel.appendChild(details);

        setupUIListeners();
        updateNpcRegistryUI();

        // Restore world log
        const settings = getSettings();
        const log = settings.world_log || [];
        if (log.length > 0) {
            const container = document.getElementById('lw-world-log');
            if (container) container.innerHTML = '';
            log.slice(-5).forEach(entry => updateWorldLogUI(entry.events));
        }
    }

    // Hook into ST events
    eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
    eventSource.on(event_types.MESSAGE_SENT, onMessageReceived);

    // Hook into prompt building for knowledge separation
    eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, onPromptReady);

    console.log('[LivingWorld] Ready ✓');
    showNotification('🌍 Living World активирован', 'success');
}

// Start
init();
