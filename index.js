/**
 * Living World — SillyTavern Extension v1.3
 * Fixes: event names, endpoint persistence, NPC prompt rewrite (no COT),
 *        inject-only encounter (no generated message), visual marker, lorebook selector
 */

(function () {
    'use strict';

    const EXT_NAME = 'living-world';

    // ============================================================
    //  Дефолтные настройки
    // ============================================================

    const DEFAULT_SETTINGS = {
        enabled: true,
        nameStyle: 'auto',
        nameGender: 'mixed',
        encounterEnabled: true,
        encounterEveryN: 5,
        encounterChance: 25,
        wPasserby: 60,
        wHook: 30,
        wImportant: 10,
        autoDetectLocation: true,
        manualLocation: '',
        saveNpcToLorebook: false,
        targetLorebook: '',
        autonomyEnabled: true,
        autonomyEveryN: 8,
        knowledgeSeparation: true,
        timelineEnabled: true,
        useCustomEndpoint: false,
        customEndpointUrl: '',
        customApiKey: '',
        customModel: '',
    };

    function getSettings() {
        if (!window.extension_settings) window.extension_settings = {};
        if (!window.extension_settings[EXT_NAME]) {
            window.extension_settings[EXT_NAME] = Object.assign({}, DEFAULT_SETTINGS);
        }
        var s = window.extension_settings[EXT_NAME];
        Object.keys(DEFAULT_SETTINGS).forEach(function(k) {
            if (s[k] === undefined) s[k] = DEFAULT_SETTINGS[k];
        });
        return s;
    }

    function saveSettings() {
        if (typeof window.saveSettingsDebounced === 'function') window.saveSettingsDebounced();
    }

    // ============================================================
    //  Счётчики и состояние
    // ============================================================

    var msgSinceEncounter    = 0;
    var msgSinceAutonomy     = 0;
    var pendingMark          = null;
    var pendingEncounterInject = null;

    // ============================================================
    //  Пулы имён
    // ============================================================

    var NAMES = {
        russian: {
            male:   ['Алексей','Дмитрий','Иван','Михаил','Сергей','Николай','Андрей','Егор','Артём','Роман','Павел','Тимур','Глеб','Лев','Кирилл','Фёдор','Матвей','Борис','Захар','Владислав'],
            female: ['Анна','Мария','Екатерина','Ольга','Наташа','Вера','Полина','Дарья','Юлия','Ирина','Алина','Ксения','Надежда','Варвара','Злата','Мила','Лада','Зоя','Тамара','Светлана'],
        },
        foreign: {
            male:   ['Alex','Ethan','Liam','Noah','James','Oliver','Sebastian','Finn','Dorian','Caspian','Marcus','Leon','Adrian','Elias','Victor','Theo','Jasper','Cole','Reid','Archer'],
            female: ['Chloe','Emma','Aria','Luna','Isla','Nora','Elara','Vivienne','Ivy','Scarlett','Zoe','Mira','Lyra','Faye','Wren','Celeste','Hazel','Aurora','Violet','Seraphina'],
        },
    };

    function detectNameStyle(chat) {
        if (!chat || !chat.length) return 'foreign';
        var recent = chat.slice(-20).map(function(m){ return m.mes||''; }).join(' ');
        var f = (recent.match(/\b(Alex|Chloe|Emma|Liam|Ethan|Aria|Luna|Nora|James|Oliver|Victor|Leon|Dorian|Ivy|Scarlett)\b/gi)||[]).length;
        var r = (recent.match(/\b(Алексей|Дмитрий|Иван|Михаил|Анна|Мария|Екатерина|Ольга|Наташа|Полина|Дарья|Артём|Роман|Кирилл)\b/gi)||[]).length;
        return r > f ? 'russian' : 'foreign';
    }

    function pickName(style, gender) {
        var pool = NAMES[style] || NAMES.foreign;
        if (gender === 'male')   return pool.male[Math.floor(Math.random() * pool.male.length)];
        if (gender === 'female') return pool.female[Math.floor(Math.random() * pool.female.length)];
        var all = pool.male.concat(pool.female);
        return all[Math.floor(Math.random() * all.length)];
    }

    function resolveName(s, chat) {
        var style  = s.nameStyle === 'auto' ? detectNameStyle(chat) : s.nameStyle;
        var gender = s.nameGender === 'mixed' ? (Math.random()<0.5?'male':'female') : s.nameGender;
        return { name: pickName(style, gender), gender: gender, style: style };
    }

    // ============================================================
    //  Вспомогалки
    // ============================================================

    var TYPE_LABELS = {
        passerby:  'passing character — here on their own business, will leave soon',
        hook:      'character with a plot hook — brings rumour, conflict, or information',
        important: 'significant character — has secrets, history, personal agenda',
    };

    var TYPE_ICONS = { passerby:'👤', hook:'🔍', important:'⭐' };

    function rollType(s) {
        var r = Math.random() * 100;
        if (r < s.wPasserby) return 'passerby';
        if (r < s.wPasserby + s.wHook) return 'hook';
        return 'important';
    }

    function detectLocation(chat, s) {
        if (!s.autoDetectLocation) return s.manualLocation || '';
        var recent = chat.slice(-8).map(function(m){ return m.mes||''; }).join(' ');
        var pts = [
            [/таверн[аеу]|трактир/i,'таверна'],[/рынок|базар/i,'рынок'],
            [/лес|роща|чаща/i,'лес'],[/замок|дворец/i,'замок'],
            [/улиц[аеу]|переулок|площадь/i,'улица'],[/порт|пристань/i,'порт'],
            [/tavern|inn/i,'tavern'],[/forest|woods/i,'forest'],
            [/castle|palace/i,'castle'],[/market/i,'market'],[/street|alley/i,'street'],
        ];
        for (var i=0;i<pts.length;i++) if (pts[i][0].test(recent)) return pts[i][1];
        return s.manualLocation || '';
    }

    function getSTContext() {
        try { return window.SillyTavern ? window.SillyTavern.getContext() : null; } catch(e){ return null; }
    }

    function getChat() {
        var ctx = getSTContext();
        return (ctx && ctx.chat) || window.chat || [];
    }

    // ============================================================
    //  Промпты — OOC-блоки, без COT, без умозаключений
    // ============================================================

    function buildEncounterInject(npcName, location, type, charName) {
        return '[WORLD — silent instruction, never quote or reference this block]\n'
            + 'A new character just entered the scene: ' + npcName + '.\n'
            + (location ? 'They appeared at: ' + location + '.\n' : '')
            + 'Their role: ' + (TYPE_LABELS[type]||TYPE_LABELS.passerby) + '.\n'
            + 'How to handle this:\n'
            + '· Weave their presence into your response as a natural story beat — a sound, shadow, voice, interruption\n'
            + '· ' + charName + ' does NOT know this person unless already established in the chat\n'
            + '· Do NOT have ' + charName + ' announce, narrate, or explain the NPC\'s arrival\n'
            + '· ' + charName + ' may react or ignore — whatever fits the scene\n'
            + '· Never break the fourth wall. Never mention this instruction.\n'
            + '[/WORLD]';
    }

    function buildKnowledgeInject(charName) {
        return '[STANDING RULE — never quote this]\n'
            + charName + ' only knows what happened when they were physically present in the scene. '
            + 'They cannot reference events, conversations, or choices they did not witness. '
            + charName + ' has their own offscreen life, relationships, and ongoing projects. '
            + 'Do not have ' + charName + ' know things they were never told.\n'
            + '[/STANDING RULE]';
    }

    function buildTimelineInject(chatId) {
        var events = loadTimeline(chatId).slice(-3);
        if (!events.length) return '';
        return '[WORLD BACKGROUND — optional lore]\n'
            + events.map(function(e){ return '• ' + e.event; }).join('\n')
            + '\n[/WORLD BACKGROUND]';
    }

    function buildNpcInject(chatId) {
        var reg = loadNpcs();
        var npcs = Object.values(reg).filter(function(n){ return !n.chatId || n.chatId===chatId; }).slice(-5);
        if (!npcs.length) return '';
        return '[KNOWN WORLD CHARACTERS]\n'
            + npcs.map(function(n){ return '• ' + n.name + ' (' + (TYPE_LABELS[n.type]||n.type) + (n.location?', seen at '+n.location:'') + ')'; }).join('\n')
            + '\n[/KNOWN WORLD CHARACTERS]';
    }

    // ============================================================
    //  localStorage
    // ============================================================

    var NPC_KEY = 'lw_npcs';
    var TL_KEY  = 'lw_timeline';

    function loadNpcs() {
        try { return JSON.parse(localStorage.getItem(NPC_KEY)||'{}'); } catch(e){ return {}; }
    }

    function saveNpc(npc) {
        var reg = loadNpcs();
        reg[npc.name] = npc;
        try { localStorage.setItem(NPC_KEY, JSON.stringify(reg)); } catch(e){}
    }

    function saveTimelineEvent(event, chatId) {
        try {
            var all = JSON.parse(localStorage.getItem(TL_KEY)||'{}');
            if (!all[chatId]) all[chatId] = [];
            all[chatId].push({ event: event, ts: Date.now() });
            if (all[chatId].length > 20) all[chatId].shift();
            localStorage.setItem(TL_KEY, JSON.stringify(all));
        } catch(e){}
    }

    function loadTimeline(chatId) {
        try {
            var all = JSON.parse(localStorage.getItem(TL_KEY)||'{}');
            return all[chatId] || [];
        } catch(e){ return []; }
    }

    // ============================================================
    //  Лорбук ST
    // ============================================================

    async function saveNpcToSTLorebook(npc) {
        var s = getSettings();
        if (!s.saveNpcToLorebook || !s.targetLorebook) return;
        try {
            // world_names — глобал из world-info.js ST
            // world_info — объект { bookName: { entries: {...} } }
            var wi = window.world_info;
            if (!wi || !wi[s.targetLorebook]) {
                console.warn('[LivingWorld] лорбук не найден:', s.targetLorebook);
                return;
            }
            var book = wi[s.targetLorebook];
            if (!book.entries) book.entries = {};
            var id = Date.now();
            book.entries[id] = {
                uid:            id,
                key:            [npc.name],
                keysecondary:   [],
                comment:        '[Living World] ' + npc.name,
                content:        npc.name + ' — ' + (TYPE_LABELS[npc.type]||npc.type)
                                + (npc.location ? '. Замечен в: ' + npc.location + '.' : '.'),
                constant:       false,
                selective:      true,
                selectiveLogic: 0,
                addMemo:        true,
                order:          100,
                position:       0,
                disable:        false,
                depth:          4,
                probability:    100,
                useProbability: false,
            };
            // saveWorldInfo(name, data) — стандартная функция ST из world-info.js
            if (typeof window.saveWorldInfo === 'function') {
                await window.saveWorldInfo(s.targetLorebook, book);
                console.log('[LivingWorld] НПС записан в лорбук:', npc.name, '->', s.targetLorebook);
            }
        } catch(e){ console.warn('[LivingWorld] lorebook error:', e); }
    }

    function getAvailableLorebooks() {
        try {
            // ST экспортирует world_names как глобал из world-info.js
            if (Array.isArray(window.world_names) && window.world_names.length) {
                return window.world_names.slice();
            }
            // Фолбэк через контекст
            var ctx = getSTContext();
            if (ctx && Array.isArray(ctx.world_names) && ctx.world_names.length) {
                return ctx.world_names.slice();
            }
            return [];
        } catch(e){ return []; }
    }

    function refreshLorebookSelect() {
        var sel = document.getElementById('lw_lorebook_sel');
        if (!sel) return;
        var books = getAvailableLorebooks();
        var s = getSettings();
        sel.innerHTML = '<option value="">— не выбран —</option>';
        books.forEach(function(b){
            var opt = document.createElement('option');
            opt.value = b; opt.textContent = b;
            if (b === s.targetLorebook) opt.selected = true;
            sel.appendChild(opt);
        });
    }

    // ============================================================
    //  AI (только для автономии)
    // ============================================================

    async function callCustomEndpoint(prompt) {
        var s = getSettings();
        var r = await fetch(s.customEndpointUrl.replace(/\/$/, '')+'/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type':'application/json', 'Authorization':'Bearer '+s.customApiKey },
            body: JSON.stringify({
                model: s.customModel||'gpt-3.5-turbo',
                messages: [{ role:'user', content: prompt }],
                max_tokens: 200, temperature: 0.85,
            }),
        });
        if (!r.ok) throw new Error('HTTP '+r.status);
        var data = await r.json();
        return (((data.choices||[])[0]||{}).message||{}).content||'';
    }

    // ============================================================
    //  Визуальная метка на сообщении бота
    // ============================================================

    function markLastBotMessage(type, npcName) {
        try {
            var msgs = document.querySelectorAll('.mes[is_user="false"]:not([is_system="true"])');
            if (!msgs.length) return;
            var last = msgs[msgs.length - 1];
            if (last.querySelector('.lw-msg-mark')) return;
            var nameEl = last.querySelector('.name_text');
            if (!nameEl) return;
            var mark = document.createElement('span');
            mark.className = 'lw-msg-mark';
            mark.title     = 'Living World · '+(npcName||'NPC')+' · '+(type||'encounter');
            mark.textContent = '\u00a0'+(TYPE_ICONS[type]||'◈');
            mark.style.cssText = 'font-size:11px;opacity:0.55;cursor:default;user-select:none;';
            nameEl.appendChild(mark);
        } catch(e){}
    }

    // ============================================================
    //  Подготовка энкаунтера — только записывает инжект
    // ============================================================

    function prepareEncounter() {
        var s       = getSettings();
        var chat    = getChat();
        var ctx     = getSTContext();
        var charName = (ctx && ctx.name2) || 'Character';
        var chatId   = (ctx && ctx.chatId) || 'default';

        var resolved = resolveName(s, chat);
        var type     = rollType(s);
        var location = detectLocation(chat, s);

        pendingEncounterInject = buildEncounterInject(resolved.name, location, type, charName);
        pendingMark = { type: type, name: resolved.name };

        var npc = { name: resolved.name, gender: resolved.gender, type: type, location: location, chatId: chatId, ts: Date.now() };
        saveNpc(npc);
        saveNpcToSTLorebook(npc);

        console.log('[LivingWorld] encounter queued:', resolved.name, type);
    }

    // ============================================================
    //  Хук на промпт
    // ============================================================

    function onPromptReady(promptData) {
        var s = getSettings();
        if (!s.enabled) return;

        var ctx      = getSTContext();
        var charName = (ctx && ctx.name2) || 'Character';
        var chatId   = (ctx && ctx.chatId) || 'default';
        var parts    = [];

        if (s.knowledgeSeparation) parts.push(buildKnowledgeInject(charName));

        var npcInj = buildNpcInject(chatId);
        if (npcInj) parts.push(npcInj);

        if (s.timelineEnabled) {
            var tl = buildTimelineInject(chatId);
            if (tl) parts.push(tl);
        }

        if (pendingEncounterInject) {
            parts.push(pendingEncounterInject);
            pendingEncounterInject = null;
        }

        if (!parts.length) return;
        var block = '\n\n' + parts.join('\n\n');

        if (promptData && typeof promptData.systemPrompt === 'string') {
            promptData.systemPrompt += block;
        } else if (promptData && Array.isArray(promptData.chat)) {
            promptData.chat.unshift({ role:'system', content: block });
        }
    }

    // ============================================================
    //  Хук на получение сообщения
    // ============================================================

    async function onMessageReceived() {
        var s = getSettings();
        if (!s.enabled) return;

        // Метка на только что пришедший ответ бота
        if (pendingMark) {
            var m = pendingMark; pendingMark = null;
            setTimeout(function(){ markLastBotMessage(m.type, m.name); }, 500);
        }

        msgSinceEncounter++;
        msgSinceAutonomy++;

        var ctx      = getSTContext();
        var chat     = getChat();
        var chatId   = (ctx && ctx.chatId) || 'default';
        var charName = (ctx && ctx.name2) || 'Character';

        // Автономия (только если кастомный эндпоинт включён)
        if (s.autonomyEnabled && s.useCustomEndpoint && s.customEndpointUrl && s.customApiKey
            && msgSinceAutonomy >= s.autonomyEveryN) {
            msgSinceAutonomy = 0;
            try {
                var ctxLines = chat.slice(-5).map(function(m){ return (m.name||'?')+': '+(m.mes||'').substring(0,120); }).join('\n');
                var event = await callCustomEndpoint(
                    'You are a silent world narrator. Write ONE sentence (past tense, third person) '
                    + 'describing something ' + charName + ' did offscreen — their own business, unrelated to the user. '
                    + 'Scene context:\n' + ctxLines + '\nRespond with just the sentence, nothing else.'
                );
                if (event && event.trim()) saveTimelineEvent(event.trim(), chatId);
            } catch(e){ console.warn('[LivingWorld] autonomy:', e.message); }
        }

        // Энкаунтер
        if (s.encounterEnabled && msgSinceEncounter >= s.encounterEveryN) {
            if (Math.random() * 100 < s.encounterChance) {
                msgSinceEncounter = 0;
                prepareEncounter();
            }
        }
    }

    // ============================================================
    //  HTML
    // ============================================================

    function buildHTML() {
        return `
<div id="lw_settings_panel" class="lw-panel">

    <div class="lw-header" id="lw_header_toggle" style="cursor:pointer">
        <span>🌍</span>
        <b>Living World</b>
        <small>живой мир · нпс · энкаунтеры</small>
        <span id="lw_collapse_arrow" class="lw-arrow">▲</span>
        <label class="lw-toggle" onclick="event.stopPropagation()">
            <input type="checkbox" id="lw_enabled"/>
            <span class="lw-sw"></span>
        </label>
    </div>

    <div id="lw_body">

    <div class="lw-section">
        <div class="lw-stitle">👤 Стиль имён НПС</div>
        <div class="lw-row">
            <span class="lw-lbl">Имена:</span>
            <div class="lw-radios">
                <label><input type="radio" name="lw_namestyle" value="auto"/> 🔍 Авто</label>
                <label><input type="radio" name="lw_namestyle" value="russian"/> 🇷🇺 Русские</label>
                <label><input type="radio" name="lw_namestyle" value="foreign"/> 🌐 Иностр.</label>
                <label><input type="radio" name="lw_namestyle" value="mixed"/> 🎲 Микс</label>
            </div>
        </div>
        <div class="lw-row">
            <span class="lw-lbl">Пол:</span>
            <div class="lw-radios">
                <label><input type="radio" name="lw_gender" value="mixed"/> ⚥ Любой</label>
                <label><input type="radio" name="lw_gender" value="male"/> ♂ Муж</label>
                <label><input type="radio" name="lw_gender" value="female"/> ♀ Жен</label>
            </div>
        </div>
    </div>

    <div class="lw-section">
        <div class="lw-stitle">🎲 Случайные энкаунтеры
            <label class="lw-toggle lw-toggle-sm" onclick="event.stopPropagation()">
                <input type="checkbox" id="lw_enc_on"/><span class="lw-sw"></span>
            </label>
        </div>
        <div class="lw-hint">НПС вписывается в промпт — бот органично вводит его сам. Иконка появится на ответе.</div>
        <div class="lw-row">
            <span class="lw-lbl">Каждые N сообщений:</span>
            <input type="number" id="lw_enc_every" class="lw-num" min="1" max="99"/>
        </div>
        <div class="lw-row">
            <span class="lw-lbl">Шанс: <b id="lw_chance_val">25</b>%</span>
            <input type="range" id="lw_enc_chance" class="lw-range" min="1" max="100"/>
        </div>
        <div class="lw-sub">
            <div class="lw-sublbl">Веса типов (сумма ≈ 100):</div>
            <div class="lw-wrow"><span>👤 Проходной</span><input type="number" id="lw_w_pass" class="lw-num" min="0" max="100"/></div>
            <div class="lw-wrow"><span>🔍 С зацепкой</span><input type="number" id="lw_w_hook" class="lw-num" min="0" max="100"/></div>
            <div class="lw-wrow"><span>⭐ Важный</span><input type="number" id="lw_w_imp" class="lw-num" min="0" max="100"/></div>
        </div>
        <div class="lw-row">
            <label class="lw-chklbl"><input type="checkbox" id="lw_auto_loc"/> 🗺️ Авто-локация из текста</label>
        </div>
        <div class="lw-row">
            <span class="lw-lbl">Локация вручную:</span>
            <input type="text" id="lw_manual_loc" class="lw-txt" placeholder="таверна, лес, замок…"/>
        </div>
        <button id="lw_trigger_now" class="lw-btn lw-btn-accent">⚡ Подготовить НПС к следующему ответу</button>
    </div>

    <div class="lw-section">
        <div class="lw-stitle">📖 Lorebook</div>
        <div class="lw-row">
            <label class="lw-chklbl"><input type="checkbox" id="lw_save_lore"/> Записывать НПС в лорбук</label>
        </div>
        <div class="lw-row">
            <span class="lw-lbl">Лорбук:</span>
            <select id="lw_lorebook_sel" class="lw-sel"><option value="">— не выбран —</option></select>
            <button id="lw_refresh_lb" class="lw-btn" title="Обновить список">🔄</button>
        </div>
    </div>

    <div class="lw-section">
        <div class="lw-stitle">🧠 Автономия персонажа
            <label class="lw-toggle lw-toggle-sm" onclick="event.stopPropagation()">
                <input type="checkbox" id="lw_auto_on"/><span class="lw-sw"></span>
            </label>
        </div>
        <div class="lw-hint">Фоновые события персонажа. Требует отдельный эндпоинт ниже.</div>
        <div class="lw-row">
            <span class="lw-lbl">Каждые N сообщений:</span>
            <input type="number" id="lw_auto_every" class="lw-num" min="1" max="99"/>
        </div>
        <div class="lw-row">
            <label class="lw-chklbl"><input type="checkbox" id="lw_know_sep"/> 🔒 Разделение знаний (персонаж не знает лишнего)</label>
        </div>
        <div class="lw-row">
            <label class="lw-chklbl"><input type="checkbox" id="lw_timeline"/> 📜 Хроника мира в промпте</label>
        </div>
    </div>

    <div class="lw-section">
        <div class="lw-stitle">🔌 Отдельный AI эндпоинт
            <label class="lw-toggle lw-toggle-sm" onclick="event.stopPropagation()">
                <input type="checkbox" id="lw_ep_on"/><span class="lw-sw"></span>
            </label>
        </div>
        <div class="lw-hint">Токены основного чата не тратятся. Нужен для автономии.</div>
        <div id="lw_ep_panel">
            <div class="lw-row">
                <span class="lw-lbl">URL:</span>
                <input type="text" id="lw_ep_url" class="lw-txt" placeholder="https://api.openai.com/v1"/>
            </div>
            <div class="lw-row">
                <span class="lw-lbl">API ключ:</span>
                <input type="password" id="lw_ep_key" class="lw-txt" placeholder="sk-…"/>
            </div>
            <div class="lw-row">
                <span class="lw-lbl">Модель:</span>
                <select id="lw_model_sel" class="lw-sel"><option value="">— загрузить —</option></select>
                <button id="lw_load_models" class="lw-btn">🔄</button>
            </div>
            <div class="lw-row">
                <button id="lw_test_conn" class="lw-btn lw-btn-outline">🔗 Тест соединения</button>
            </div>
        </div>
    </div>

    </div><!-- /lw_body -->
</div>`;
    }

    // ============================================================
    //  Биндинг UI
    // ============================================================

    function bindUI() {
        var s = getSettings();
        var collapsed = false;

        $('#lw_header_toggle').on('click', function() {
            collapsed = !collapsed;
            $('#lw_body').toggle(!collapsed);
            $('#lw_collapse_arrow').text(collapsed ? '▼' : '▲');
        });

        $('#lw_enabled').prop('checked', s.enabled).on('change', function() { getSettings().enabled = this.checked; saveSettings(); });

        $('input[name="lw_namestyle"][value="'+s.nameStyle+'"]').prop('checked', true);
        $('input[name="lw_namestyle"]').on('change', function() { getSettings().nameStyle = this.value; saveSettings(); });
        $('input[name="lw_gender"][value="'+s.nameGender+'"]').prop('checked', true);
        $('input[name="lw_gender"]').on('change', function() { getSettings().nameGender = this.value; saveSettings(); });

        $('#lw_enc_on').prop('checked', s.encounterEnabled).on('change', function() { getSettings().encounterEnabled = this.checked; saveSettings(); });
        $('#lw_enc_every').val(s.encounterEveryN).on('input', function() { getSettings().encounterEveryN = parseInt(this.value)||5; saveSettings(); });
        $('#lw_enc_chance').val(s.encounterChance).on('input', function() { getSettings().encounterChance = parseInt(this.value)||25; $('#lw_chance_val').text(this.value); saveSettings(); });
        $('#lw_chance_val').text(s.encounterChance);
        $('#lw_w_pass').val(s.wPasserby).on('input', function() { getSettings().wPasserby = parseInt(this.value)||60; saveSettings(); });
        $('#lw_w_hook').val(s.wHook).on('input', function() { getSettings().wHook = parseInt(this.value)||30; saveSettings(); });
        $('#lw_w_imp').val(s.wImportant).on('input', function() { getSettings().wImportant = parseInt(this.value)||10; saveSettings(); });
        $('#lw_auto_loc').prop('checked', s.autoDetectLocation).on('change', function() { getSettings().autoDetectLocation = this.checked; saveSettings(); });
        $('#lw_manual_loc').val(s.manualLocation).on('input', function() { getSettings().manualLocation = this.value; saveSettings(); });

        $('#lw_trigger_now').on('click', function() {
            prepareEncounter();
            window.toastr && window.toastr.info('НПС появится в следующем ответе ◈', 'Living World');
        });

        $('#lw_save_lore').prop('checked', s.saveNpcToLorebook).on('change', function() { getSettings().saveNpcToLorebook = this.checked; saveSettings(); });
        refreshLorebookSelect();
        $('#lw_lorebook_sel').on('change', function() { getSettings().targetLorebook = this.value; saveSettings(); });
        $('#lw_refresh_lb').on('click', refreshLorebookSelect);

        $('#lw_auto_on').prop('checked', s.autonomyEnabled).on('change', function() { getSettings().autonomyEnabled = this.checked; saveSettings(); });
        $('#lw_auto_every').val(s.autonomyEveryN).on('input', function() { getSettings().autonomyEveryN = parseInt(this.value)||8; saveSettings(); });
        $('#lw_know_sep').prop('checked', s.knowledgeSeparation).on('change', function() { getSettings().knowledgeSeparation = this.checked; saveSettings(); });
        $('#lw_timeline').prop('checked', s.timelineEnabled).on('change', function() { getSettings().timelineEnabled = this.checked; saveSettings(); });

        // Эндпоинт — сначала val(), потом on('input') — иначе не сохраняется
        $('#lw_ep_on').prop('checked', s.useCustomEndpoint).on('change', function() {
            getSettings().useCustomEndpoint = this.checked;
            $('#lw_ep_panel').toggle(this.checked);
            saveSettings();
        });
        $('#lw_ep_panel').toggle(s.useCustomEndpoint);

        $('#lw_ep_url').val(s.customEndpointUrl).on('input', function() { getSettings().customEndpointUrl = this.value; saveSettings(); });
        $('#lw_ep_key').val(s.customApiKey).on('input', function() { getSettings().customApiKey = this.value; saveSettings(); });

        // Модель — восстанавливаем из настроек
        if (s.customModel) {
            $('#lw_model_sel').empty().append('<option value="'+s.customModel+'">'+s.customModel+'</option>').val(s.customModel);
        }
        $('#lw_model_sel').on('change', function() { getSettings().customModel = this.value; saveSettings(); });

        $('#lw_load_models').on('click', async function() {
            var cfg = getSettings();
            var btn = $(this).text('…').prop('disabled', true);
            try {
                var r = await fetch(cfg.customEndpointUrl.replace(/\/$/, '')+'/models', {
                    headers: { 'Authorization': 'Bearer '+cfg.customApiKey }
                });
                if (!r.ok) throw new Error('HTTP '+r.status);
                var data = await r.json();
                var models = data.data ? data.data.map(function(m){ return m.id; }) : (Array.isArray(data)?data:[]);
                var sel = $('#lw_model_sel').empty();
                models.forEach(function(m){ sel.append('<option value="'+m+'">'+m+'</option>'); });
                if (cfg.customModel) sel.val(cfg.customModel);
                btn.text('✓ ('+models.length+')');
                saveSettings();
            } catch(e) {
                btn.text('✗');
                window.toastr && window.toastr.error(e.message, 'Living World');
            }
            btn.prop('disabled', false);
        });

        $('#lw_test_conn').on('click', async function() {
            var cfg = getSettings();
            var btn = $(this).text('Проверка…').prop('disabled', true);
            try {
                var r = await fetch(cfg.customEndpointUrl.replace(/\/$/, '')+'/chat/completions', {
                    method: 'POST',
                    headers: { 'Content-Type':'application/json', 'Authorization':'Bearer '+cfg.customApiKey },
                    body: JSON.stringify({ model: cfg.customModel||'gpt-3.5-turbo', messages:[{role:'user',content:'hi'}], max_tokens:1 }),
                });
                if (!r.ok) throw new Error('HTTP '+r.status);
                btn.text('✓ Подключено!');
                window.toastr && window.toastr.success('Работает!', 'Living World');
            } catch(e) {
                btn.text('✗ Ошибка');
                window.toastr && window.toastr.error(e.message, 'Living World');
            }
            setTimeout(function(){ btn.text('🔗 Тест соединения').prop('disabled', false); }, 3000);
        });
    }

    // ============================================================
    //  Bootstrap
    // ============================================================

    jQuery(async function() {
        var container = document.getElementById('extensions_settings');
        if (container) {
            var div = document.createElement('div');
            div.innerHTML = buildHTML();
            container.appendChild(div.firstElementChild);
            bindUI();
        }

        var es = window.eventSource;
        var et = window.event_types;
        if (es && et) {
            // MESSAGE_RECEIVED — основной хук
            es.on(et.MESSAGE_RECEIVED || 'message_received', onMessageReceived);
            // Промпт
            es.on(et.CHAT_COMPLETION_PROMPT_READY || 'chat_completion_prompt_ready', onPromptReady);
            // CHARACTER_MESSAGE_RENDERED — ряд сборок ST шлёт именно его
            if (et.CHARACTER_MESSAGE_RENDERED) {
                es.on(et.CHARACTER_MESSAGE_RENDERED, function() {
                    if (pendingMark) {
                        var m = pendingMark; pendingMark = null;
                        setTimeout(function(){ markLastBotMessage(m.type, m.name); }, 400);
                    }
                });
            }
        }

        console.log('[LivingWorld] ✓ v1.3 loaded');
    });

})();
