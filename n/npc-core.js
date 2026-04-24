// ============================================================
//  Living World — SillyTavern Extension
//  Модуль: настройки и генерация НПС
// ============================================================

export const DEFAULT_SETTINGS = {
    enabled: true,

    // --- Отдельный AI эндпоинт ---
    useCustomEndpoint: false,
    customEndpointUrl: '',
    customApiKey: '',
    customModel: '',
    availableModels: [],

    // --- Имена НПС ---
    nameStyle: 'auto',        // 'auto' | 'russian' | 'foreign' | 'mixed'
    nameGender: 'mixed',      // 'male' | 'female' | 'mixed'

    // --- Рандомные энкаунтеры ---
    encounterEnabled: true,
    encounterEveryN: 5,       // каждые N сообщений
    encounterChance: 25,      // % шанс появления
    encounterWeights: {
        passerby: 60,         // проходной НПС
        hook: 30,             // НПС с зацепкой
        important: 10,        // важный НПС
    },
    autoDetectLocation: true,
    manualLocation: '',
    saveNpcToLorebook: true,

    // --- Автономная жизнь персонажа ---
    autonomyEnabled: true,
    autonomyEveryN: 8,        // каждые N сообщений
    knowledgeSeparation: true, // персонаж не знает о сценах без него

    // --- Таймлайн мира ---
    timelineEnabled: true,
};

// ============================================================
//  Пулы имён
// ============================================================

const NAMES = {
    russian: {
        male:   ['Алексей','Дмитрий','Иван','Михаил','Сергей','Николай','Андрей','Владимир','Егор','Артём','Роман','Павел','Тимур','Глеб','Лев','Кирилл','Фёдор','Матвей','Борис','Захар'],
        female: ['Анна','Мария','Екатерина','Ольга','Наташа','Вера','Полина','Дарья','Юлия','Ирина','Светлана','Алина','Ксения','Надежда','Тамара','Варвара','Злата','Мила','Лада','Зоя'],
    },
    foreign: {
        male:   ['Alex','Ethan','Liam','Noah','James','Oliver','Sebastian','Finn','Dorian','Caspian','Marcus','Leon','Adrian','Elias','Victor','Theo','Jasper','Cole','Reid','Archer'],
        female: ['Chloe','Emma','Aria','Luna','Isla','Nora','Elara','Vivienne','Ivy','Scarlett','Zoe','Mira','Lyra','Faye','Wren','Celeste','Hazel','Aurora','Seraphina','Violet'],
    },
};

/**
 * Определяет стиль имён по контексту последних сообщений
 */
export function detectNameStyleFromContext(chatMessages) {
    if (!chatMessages || chatMessages.length === 0) return 'foreign';

    const recent = chatMessages.slice(-20).map(m => m.mes || '').join(' ');

    // Ищем уже встречавшиеся имена в чате
    const foreignPattern = /\b(Alex|Chloe|Emma|Liam|Ethan|Aria|Luna|Nora|James|Oliver|Victor|Leon|Dorian|Ivy|Scarlett)\b/gi;
    const russianPattern = /\b(Алексей|Дмитрий|Иван|Михаил|Анна|Мария|Екатерина|Ольга|Наташа|Полина|Дарья|Артём|Роман|Кирилл)\b/gi;

    const foreignMatches = (recent.match(foreignPattern) || []).length;
    const russianMatches  = (recent.match(russianPattern) || []).length;

    if (russianMatches > foreignMatches) return 'russian';
    if (foreignMatches > russianMatches) return 'foreign';
    return 'foreign'; // дефолт
}

/**
 * Выбирает случайное имя по стилю и полу
 */
export function pickName(style, gender) {
    const pool = NAMES[style] || NAMES.foreign;
    if (gender === 'male')   return pool.male[Math.floor(Math.random() * pool.male.length)];
    if (gender === 'female') return pool.female[Math.floor(Math.random() * pool.female.length)];
    // mixed
    const allNames = [...pool.male, ...pool.female];
    return allNames[Math.floor(Math.random() * allNames.length)];
}

/**
 * Разрешает имя с учётом настроек
 */
export function resolveName(settings, chatMessages) {
    let style = settings.nameStyle;
    if (style === 'auto') {
        style = detectNameStyleFromContext(chatMessages);
    }
    const gender = settings.nameGender === 'mixed'
        ? (Math.random() < 0.5 ? 'male' : 'female')
        : settings.nameGender;
    return { name: pickName(style, gender), gender, style };
}

// ============================================================
//  Веса энкаунтеров
// ============================================================

export function rollEncounterType(weights) {
    const r = Math.random() * 100;
    if (r < weights.passerby)  return 'passerby';
    if (r < weights.passerby + weights.hook) return 'hook';
    return 'important';
}

export function shouldTriggerEncounter(chance) {
    return Math.random() * 100 < chance;
}

// ============================================================
//  Формирование промптов
// ============================================================

export function buildEncounterPrompt(npcName, npcGender, location, encounterType, chatContext) {
    const typeHint = {
        passerby:  'Это проходной персонаж — он здесь по своим делам, не связанным с главным героем. Его появление оживляет мир, но он скоро уйдёт.',
        hook:      'Этот персонаж приносит зацепку — информацию, просьбу, слух, конфликт или намёк на что-то большее.',
        important: 'Этот персонаж потенциально важен для сюжета. У него есть своя история, мотивация и тайна.',
    }[encounterType];

    return `Ты нарратор живого мира. Твоя задача — описать появление случайного персонажа в сцене.

Имя НПС: ${npcName}
Локация: ${location || 'текущая сцена'}
Тип появления: ${typeHint}

Последний контекст сцены:
${chatContext}

Напиши короткое появление этого персонажа (2-4 предложения) от третьего лица. 
НПС приходит по СВОИМ делам — не искать главного героя специально.
Не упоминай имя главного героя напрямую. Создай интригу или живую атмосферу.
Отвечай только текстом появления, без пояснений.`;
}

export function buildAutonomyPrompt(charName, lastKnownLocation, chatContext) {
    return `Ты нарратор. Персонаж по имени ${charName} какое-то время провёл без главного героя.

Последнее известное место: ${lastKnownLocation || 'неизвестно'}
Контекст до разлуки: ${chatContext}

Придумай 2-3 коротких события, которые произошли с ${charName} за это время.
Он НЕ знает что делал главный герой в его отсутствие.
События должны быть про его собственную жизнь: дела, встречи, мысли, небольшие происшествия.
Отвечай кратко, в формате нарратива от третьего лица.`;
}

export function buildKnowledgeSeparationInject(charName) {
    return `[СИСТЕМНОЕ ПРАВИЛО МИРА: ${charName} не обладает телепатией и не знает о событиях, при которых он не присутствовал лично. Информацию о происходящем без него он может получить только если ему об этом сообщат напрямую в сцене. Он живёт своей жизнью и имеет собственные дела, не зависящие от главного героя.]`;
}
