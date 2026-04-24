// ============================================================
//  Living World — SillyTavern Extension
//  Главный файл: регистрация, хуки, UI логика
// ============================================================

import {
    DEFAULT_SETTINGS,
    resolveName,
    rollEncounterType,
    shouldTriggerEncounter,
    buildEncounterPrompt,
    buildAutonomyPrompt,
    buildKnowledgeSeparationInject,
} from './src/npc-core.js';

import {
    generateNpcText,
    fetchModelsFromEndpoint,
    testEndpointConnection,
} from './src/endpoint.js';

import {
    loadNpcRegistry,
    saveNpcToRegistry,
    createNpcCard,
    addNpcToSillyTavernLorebook,
    buildActiveNpcsInject,
    saveTimelineEvent,
    buildTimelineInject,
} from './src/npc-memory.js';

// ============================================================
//  ST API (injected globals)
// ============================================================

const {
    getContext,
    saveSettingsDebounced,
    eventSource,
    event_types,
    generateRaw,
    substituteParams,
} = window.SillyTavern?.getContext?.() ?? {};

const extensionName   = 'living-world';
const extensionFolder = `scripts/extensions/third-party/${extensionName}`;

// ============================================================
//  Инициализация настроек
// ============================================================

function getSettings() {
    const ctx = getContext?.();
    if (!ctx?.extensionSettings) return { ...DEFAULT_SETTINGS };
    if (!ctx.extensionSettings[extensionName]) {
        ctx.extensionSettings[extensionName] = { ...DEFAULT_SETTINGS };
    }
    return ctx.extensionSettings[extensionName];
}

function saveSettings() {
    saveSettingsDebounced?.();
}

// ============================================================
//  Счётчики сообщений
// ============================================================

let messagesSinceEncounter = 0;
let messagesSinceAutonomy  = 0;

// ============================================================
//  Основная логика: хук на каждое сообщение
// ============================================================

async function onMessageReceived() {
    const settings = getSettings();
    if (!settings.enabled) return;

    const ctx     = getContext?.();
    const chat    = ctx?.chat ?? [];
    const charName = ctx?.name2 ?? 'Персонаж';
    const chatId   = ctx?.chatId ?? 'default';

    messagesSinceEncounter++;
    messagesSinceAutonomy++;

    // --- Автономные события персонажа ---
    if (settings.autonomyEnabled && messagesSinceAutonomy >= settings.autonomyEveryN) {
        messagesSinceAutonomy = 0;
        try {
            const context  = chat.slice(-6).map(m => `${m.name}: ${m.mes}`).join('\n');
            const prompt   = buildAutonomyPrompt(charName, settings.manualLocation, context);
            const event    = await generateNpcText(settings, prompt, generateRaw);
            if (event) {
                saveTimelineEvent(charName, event, chatId);
                console.log(`[LivingWorld] Автономное событие: ${event.substring(0, 80)}...`);
            }
        } catch (e) {
            console.warn('[LivingWorld] Ошибка автономии:', e);
        }
    }

    // --- Случайный энкаунтер ---
    if (
        settings.encounterEnabled &&
        messagesSinceEncounter >= settings.encounterEveryN &&
        shouldTriggerEncounter(settings.encounterChance)
    ) {
        messagesSinceEncounter = 0;
        await triggerEncounter(settings, chat, chatId);
    }
}

// ============================================================
//  Триггер энкаунтера
// ============================================================

async function triggerEncounter(settings, chat, chatId) {
    const ctx      = getContext?.();
    const charName = ctx?.name2 ?? 'Персонаж';

    const { name: npcName, gender, style } = resolveName(settings, chat);
    const encounterType = rollEncounterType(settings.encounterWeights);
    const location = detectLocation(chat, settings);
    const context  = chat.slice(-4).map(m => `${m.name}: ${m.mes}`).join('\n');
    const prompt   = buildEncounterPrompt(npcName, gender, location, encounterType, context);

    try {
        const description = await generateNpcText(settings, prompt, generateRaw);
        if (!description) return;

        // Сохраняем НПС
        const npc = createNpcCard({ name: npcName, gender, style, encounterType, location, description, chatId });
        saveNpcToRegistry(npc);

        if (settings.saveNpcToLorebook) {
            await addNpcToSillyTavernLorebook(npc, ctx?.worldInfo);
        }

        // Инжектим появление в чат как нарраторское сообщение
        injectNarratorMessage(description, npcName, encounterType);

        console.log(`[LivingWorld] Энкаунтер: ${npcName} (${encounterType})`);
    } catch (e) {
        console.warn('[LivingWorld] Ошибка энкаунтера:', e);
    }
}

// ============================================================
//  Инжект нарраторского сообщения в чат
// ============================================================

function injectNarratorMessage(text, npcName, type) {
    const typeEmoji = { passerby: '👤', hook: '🔍', important: '⭐' }[type] || '👤';
    const header    = `${typeEmoji} *[Живой мир — ${npcName}]*`;

    // Добавляем в чат как системное сообщение через ST API
    const ctx = getContext?.();
    if (ctx?.addOneMessage) {
        ctx.addOneMessage({
            name:        'Нарратор',
            is_user:     false,
            is_system:   true,
            mes:         `${header}\n\n${text}`,
            extra:       { living_world: true, npc: npcName },
        });
    } else {
        // Фолбэк: просто выводим в консоль и тост
        toastr?.info(`${header}: ${text.substring(0, 100)}...`, 'Living World');
    }
}

// ============================================================
//  Детектор локации
// ============================================================

function detectLocation(chat, settings) {
    if (!settings.autoDetectLocation) return settings.manualLocation || '';

    const recent = chat.slice(-8).map(m => m.mes || '').join(' ');

    const locationPatterns = [
        { re: /таверн[аеу]|трактир/i,          label: 'таверна' },
        { re: /рынок|базар|торговая площадь/i,  label: 'рынок' },
        { re: /лес|роща|чаща/i,                 label: 'лес' },
        { re: /замок|дворец|тронный зал/i,      label: 'замок' },
        { re: /улиц[аеу]|переулок|площадь/i,   label: 'улица' },
        { re: /порт|пристань|корабль/i,         label: 'порт' },
        { re: /тюрьма|темниц[аеу]/i,            label: 'тюрьма' },
        { re: /temple|church|cathedral/i,        label: 'temple' },
        { re: /tavern|inn|bar/i,                 label: 'tavern' },
        { re: /forest|woods|grove/i,             label: 'forest' },
        { re: /castle|palace|throne/i,           label: 'castle' },
        { re: /market|bazaar|plaza/i,            label: 'market' },
        { re: /street|alley|square/i,            label: 'street' },
    ];

    for (const { re, label } of locationPatterns) {
        if (re.test(recent)) return label;
    }

    return settings.manualLocation || 'текущая локация';
}

// ============================================================
//  Хук на системный промпт — инжектим разделение знаний
// ============================================================

function onPromptReady(promptData) {
    const settings = getSettings();
    if (!settings.enabled) return;

    const ctx      = getContext?.();
    const charName = ctx?.name2 ?? 'Персонаж';
    const chatId   = ctx?.chatId ?? 'default';
    const registry = loadNpcRegistry();

    const injections = [];

    if (settings.knowledgeSeparation) {
        injections.push(buildKnowledgeSeparationInject(charName));
    }

    if (settings.timelineEnabled) {
        const timelineInject = buildTimelineInject(chatId);
        if (timelineInject) injections.push(timelineInject);
    }

    const npcInject = buildActiveNpcsInject(registry, chatId);
    if (npcInject) injections.push(npcInject);

    if (injections.length > 0 && promptData?.chat) {
        // Добавляем как системное сообщение в конец системных промптов
        const inject = injections.join('\n\n');
        if (promptData.systemPrompt !== undefined) {
            promptData.systemPrompt += '\n\n' + inject;
        }
    }
}

// ============================================================
//  UI — панель настроек
// ============================================================

async function loadSettingsPanel() {
    const response = await fetch(`/${extensionFolder}/settings.html`);
    const html     = await response.text();

    $('#extensions_settings').append(html);
    bindSettingsUI();
}

function bindSettingsUI() {
    const s = getSettings();

    // Главный тоггл
    $('#lw_enabled').prop('checked', s.enabled).on('change', function () {
        getSettings().enabled = this.checked;
        saveSettings();
    });

    // Имена
    $('input[name="lw_name_style"]').filter(`[value="${s.nameStyle}"]`).prop('checked', true);
    $('input[name="lw_name_style"]').on('change', function () {
        getSettings().nameStyle = this.value;
        saveSettings();
    });

    $('input[name="lw_name_gender"]').filter(`[value="${s.nameGender}"]`).prop('checked', true);
    $('input[name="lw_name_gender"]').on('change', function () {
        getSettings().nameGender = this.value;
        saveSettings();
    });

    // Энкаунтеры
    $('#lw_encounter_enabled').prop('checked', s.encounterEnabled).on('change', function () {
        getSettings().encounterEnabled = this.checked;
        saveSettings();
    });
    $('#lw_encounter_every').val(s.encounterEveryN).on('input', function () {
        getSettings().encounterEveryN = parseInt(this.value) || 5;
        saveSettings();
    });
    $('#lw_encounter_chance').val(s.encounterChance).on('input', function () {
        getSettings().encounterChance = parseInt(this.value) || 25;
        $('#lw_chance_label').text(this.value + '%');
        saveSettings();
    });
    $('#lw_chance_label').text(s.encounterChance + '%');

    $('#lw_w_passerby').val(s.encounterWeights.passerby).on('input', function () {
        getSettings().encounterWeights.passerby = parseInt(this.value) || 60;
        saveSettings();
    });
    $('#lw_w_hook').val(s.encounterWeights.hook).on('input', function () {
        getSettings().encounterWeights.hook = parseInt(this.value) || 30;
        saveSettings();
    });
    $('#lw_w_important').val(s.encounterWeights.important).on('input', function () {
        getSettings().encounterWeights.important = parseInt(this.value) || 10;
        saveSettings();
    });

    $('#lw_auto_location').prop('checked', s.autoDetectLocation).on('change', function () {
        getSettings().autoDetectLocation = this.checked;
        saveSettings();
    });
    $('#lw_manual_location').val(s.manualLocation).on('input', function () {
        getSettings().manualLocation = this.value;
        saveSettings();
    });
    $('#lw_save_lorebook').prop('checked', s.saveNpcToLorebook).on('change', function () {
        getSettings().saveNpcToLorebook = this.checked;
        saveSettings();
    });

    // Автономия
    $('#lw_autonomy_enabled').prop('checked', s.autonomyEnabled).on('change', function () {
        getSettings().autonomyEnabled = this.checked;
        saveSettings();
    });
    $('#lw_autonomy_every').val(s.autonomyEveryN).on('input', function () {
        getSettings().autonomyEveryN = parseInt(this.value) || 8;
        saveSettings();
    });
    $('#lw_knowledge_sep').prop('checked', s.knowledgeSeparation).on('change', function () {
        getSettings().knowledgeSeparation = this.checked;
        saveSettings();
    });
    $('#lw_timeline_enabled').prop('checked', s.timelineEnabled).on('change', function () {
        getSettings().timelineEnabled = this.checked;
        saveSettings();
    });

    // Кастомный эндпоинт
    $('#lw_custom_endpoint_enabled').prop('checked', s.useCustomEndpoint).on('change', function () {
        getSettings().useCustomEndpoint = this.checked;
        $('#lw_endpoint_panel').toggle(this.checked);
        saveSettings();
    });
    $('#lw_endpoint_panel').toggle(s.useCustomEndpoint);

    $('#lw_endpoint_url').val(s.customEndpointUrl).on('input', function () {
        getSettings().customEndpointUrl = this.value;
        saveSettings();
    });
    $('#lw_endpoint_key').val(s.customApiKey).on('input', function () {
        getSettings().customApiKey = this.value;
        saveSettings();
    });

    // Загрузка моделей
    $('#lw_load_models').on('click', async function () {
        const cfg = getSettings();
        const btn = $(this);
        btn.text('Загрузка...').prop('disabled', true);
        try {
            const models = await fetchModelsFromEndpoint(cfg.customEndpointUrl, cfg.customApiKey);
            const select = $('#lw_model_select').empty();
            models.forEach(m => select.append(`<option value="${m}">${m}</option>`));
            if (cfg.customModel) select.val(cfg.customModel);
            select.on('change', function () {
                getSettings().customModel = this.value;
                saveSettings();
            });
            btn.text(`✓ Загружено (${models.length})`);
        } catch (e) {
            btn.text('Ошибка загрузки');
            toastr?.error(e.message, 'Living World');
        }
        btn.prop('disabled', false);
    });

    // Тест соединения
    $('#lw_test_connection').on('click', async function () {
        const cfg = getSettings();
        const btn = $(this);
        btn.text('Проверка...').prop('disabled', true);
        try {
            await testEndpointConnection(cfg.customEndpointUrl, cfg.customApiKey, cfg.customModel);
            btn.text('✓ Подключено!').css('color', 'var(--success)');
            toastr?.success('Эндпоинт работает!', 'Living World');
        } catch (e) {
            btn.text('✗ Ошибка').css('color', 'var(--danger)');
            toastr?.error(e.message, 'Living World');
        }
        setTimeout(() => btn.text('Тест соединения').css('color', '').prop('disabled', false), 3000);
    });

    // Ручной триггер энкаунтера
    $('#lw_trigger_now').on('click', async function () {
        const ctx  = getContext?.();
        const chat = ctx?.chat ?? [];
        const chatId = ctx?.chatId ?? 'default';
        toastr?.info('Генерация НПС...', 'Living World');
        await triggerEncounter(getSettings(), chat, chatId);
    });
}

// ============================================================
//  Инициализация расширения
// ============================================================

jQuery(async () => {
    // Загружаем панель настроек
    try {
        await loadSettingsPanel();
    } catch (e) {
        console.error('[LivingWorld] Не удалось загрузить UI:', e);
    }

    // Подписываемся на события SillyTavern
    if (eventSource) {
        eventSource.on(event_types.MESSAGE_RECEIVED,    onMessageReceived);
        eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, onPromptReady);
    }

    console.log('[LivingWorld] ✓ Расширение загружено');
});
