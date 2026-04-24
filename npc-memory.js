// ============================================================
//  Living World — Менеджер памяти НПС и Lorebook
// ============================================================

const NPC_STORAGE_KEY = 'living_world_npcs';

/**
 * Загружает всех сохранённых НПС из localStorage
 */
export function loadNpcRegistry() {
    try {
        const raw = localStorage.getItem(NPC_STORAGE_KEY);
        return raw ? JSON.parse(raw) : {};
    } catch {
        return {};
    }
}

/**
 * Сохраняет НПС в реестр
 */
export function saveNpcToRegistry(npc) {
    const registry = loadNpcRegistry();
    registry[npc.name] = {
        ...npc,
        updatedAt: Date.now(),
    };
    localStorage.setItem(NPC_STORAGE_KEY, JSON.stringify(registry));
    return registry;
}

/**
 * Создаёт карточку НПС
 */
export function createNpcCard({ name, gender, style, encounterType, location, description, chatId }) {
    return {
        name,
        gender,
        style,
        encounterType,
        location,
        description,
        chatId,
        createdAt: Date.now(),
        appearances: 1,
        knownToMain: false, // главный персонаж ещё не в курсе
    };
}

/**
 * Форматирует НПС для инжекта в lorebook
 * Возвращает строку для World Info entry
 */
export function formatNpcForLorebook(npc) {
    const typeLabel = {
        passerby:  'Проходной персонаж',
        hook:      'Персонаж с зацепкой',
        important: 'Значимый персонаж',
    }[npc.encounterType] || 'НПС';

    return `[НПС: ${npc.name} | ${typeLabel} | Место встречи: ${npc.location || '?'} | ${npc.description}]`;
}

/**
 * Добавляет НПС в World Info таверны если API доступен
 */
export async function addNpcToSillyTavernLorebook(npc, worldInfoApi) {
    if (!worldInfoApi) return false;

    try {
        const entry = {
            key:       [npc.name],
            content:   formatNpcForLorebook(npc),
            comment:   `[Living World] ${npc.name}`,
            enabled:   true,
            constant:  false,
            selective: true,
        };

        // SillyTavern World Info API
        if (typeof worldInfoApi.createEntry === 'function') {
            await worldInfoApi.createEntry(entry);
            return true;
        }
    } catch (e) {
        console.warn('[LivingWorld] Не удалось добавить в lorebook:', e);
    }
    return false;
}

/**
 * Строит инжект из активных НПС для системного промпта
 */
export function buildActiveNpcsInject(registry, currentChatId) {
    const npcs = Object.values(registry)
        .filter(n => n.chatId === currentChatId || !n.chatId)
        .slice(-5); // последние 5 НПС

    if (npcs.length === 0) return '';

    const lines = npcs.map(n => formatNpcForLorebook(n));
    return `[ИЗВЕСТНЫЕ ПЕРСОНАЖИ МИРА:\n${lines.join('\n')}]`;
}

/**
 * Хранилище автономных событий персонажа
 */
const TIMELINE_KEY = 'living_world_timeline';

export function saveTimelineEvent(charName, event, chatId) {
    try {
        const raw      = localStorage.getItem(TIMELINE_KEY);
        const timeline = raw ? JSON.parse(raw) : {};
        if (!timeline[chatId]) timeline[chatId] = [];
        timeline[chatId].push({ charName, event, ts: Date.now() });
        // Хранить последние 20 событий
        if (timeline[chatId].length > 20) timeline[chatId].shift();
        localStorage.setItem(TIMELINE_KEY, JSON.stringify(timeline));
    } catch (e) {
        console.warn('[LivingWorld] Ошибка сохранения таймлайна:', e);
    }
}

export function loadTimeline(chatId) {
    try {
        const raw = localStorage.getItem(TIMELINE_KEY);
        const all = raw ? JSON.parse(raw) : {};
        return all[chatId] || [];
    } catch {
        return [];
    }
}

export function buildTimelineInject(chatId) {
    const events = loadTimeline(chatId).slice(-3);
    if (events.length === 0) return '';
    const lines = events.map(e => `• ${e.event}`);
    return `[ХРОНИКА МИРА (последние события):\n${lines.join('\n')}]`;
}
