/**
 * Living World Extension for SillyTavern
 * Adds autonomous NPC encounters, offscreen character life, and knowledge separation
 */

import {
    eventSource,
    event_types,
    generateQuietPrompt,
    getRequestHeaders,
    saveSettingsDebounced,
    substituteParams,
} from '../../../../script.js';

import { extension_settings, getContext, saveMetadataDebounced } from '../../../extensions.js';
import { world_info, getWorldInfoPrompt } from '../../../world-info.js';

const EXT_NAME = 'living-world';
const EXT_DISPLAY = 'Living World';

// ─── Default settings ────────────────────────────────────────────────────────
const DEFAULT_SETTINGS = {
    enabled: true,

    // NPC Encounters
    encounters_enabled: true,
    encounter_chance: 25,           // % per trigger check
    trigger_every_n: 5,             // messages between checks
    npc_gender: 'random',           // 'male' | 'female' | 'random'
    npc_name_style: 'english',      // 'english' | 'russian' | 'fantasy' | 'mixed'
    npc_weight_minor: 60,
    npc_weight_hook: 30,
    npc_weight_major: 10,
    auto_detect_location: true,
    manual_location: '',
    save_npcs_to_lorebook: true,
    encounter_inject_style: 'narrative', // 'narrative' | 'ooc'

    // Offscreen Life
    offscreen_enabled: true,
    offscreen_every_n: 10,          // messages between offscreen updates
    offscreen_events_count: 2,      // how many events to generate

    // Knowledge Separation
    knowledge_sep_enabled: true,

    // Autonomy Tick
    autonomy_enabled: true,
    autonomy_every_n: 8,

    // Internal counters (saved per session)
    _msg_counter: 0,
    _offscreen_counter: 0,
    _autonomy_counter: 0,
};

// ─── Name pools ───────────────────────────────────────────────────────────────
const NAMES = {
    english: {
        male:   ['Aldric','Bennett','Callum','Dorian','Edmund','Finn','Gareth','Harold','Ivan','Julian','Kieran','Leon','Marcus','Nolan','Oscar','Percy','Quinn','Roland','Seth','Tobias','Ulric','Victor','Wren','Xavier','York','Zane'],
        female: ['Ada','Briar','Clara','Diana','Elara','Faye','Gwen','Hazel','Iris','Jade','Kira','Luna','Mara','Nora','Opal','Pearl','Quinn','Rosa','Sera','Thea','Una','Vela','Willa','Xena','Yara','Zoe'],
    },
    russian: {
        male:   ['Алексей','Борис','Василий','Глеб','Дмитрий','Егор','Захар','Иван','Кирилл','Лев','Максим','Никита','Олег','Павел','Роман','Семён','Тимур','Фёдор','Юрий','Яков'],
        female: ['Алина','Варвара','Галина','Дарья','Екатерина','Жанна','Зоя','Ирина','Ксения','Людмила','Марина','Надежда','Ольга','Полина','Светлана','Татьяна','Ульяна','Юлия','Яна'],
    },
    fantasy: {
        male:   ['Aeryn','Balthazar','Caelan','Draven','Erevan','Faelen','Gideon','Harkon','Ilian','Joren','Kael','Lyander','Morvyn','Naur','Oryn','Pharos','Quillan','Raeven','Solus','Thyren','Uther','Vorn','Wynden','Xaros','Yndel','Zarek'],
        female: ['Aelith','Brynn','Caelia','Dwyn','Elowen','Faeryn','Galayne','Hestara','Ilara','Jyndra','Kaela','Lyris','Myra','Naeva','Oriel','Phaera','Quessa','Rhea','Sylara','Tayne','Uriell','Vanya','Wynara','Xyla','Ysolde','Zarae'],
    },
    mixed: {
        male:   [],
        female: [],
    },
};
// Mixed = all pools combined
NAMES.mixed.male   = [...NAMES.english.male,   ...NAMES.russian.male,   ...NAMES.fantasy.male];
NAMES.mixed.female = [...NAMES.english.female, ...NAMES.russian.female, ...NAMES.fantasy.female];

function randomFrom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function generateNPCName(settings) {
    const style  = settings.npc_name_style || 'english';
    const gender = settings.npc_gender === 'random'
        ? (Math.random() < 0.5 ? 'male' : 'female')
        : settings.npc_gender;
    const pool = NAMES[style]?.[gender] || NAMES.english.male;
    return { name: randomFrom(pool), gender };
}

// ─── Location parser ──────────────────────────────────────────────────────────
function detectLocation(chatMessages) {
    const keywords = {
        tavern:   ['tavern','таверна','inn','трактир','bar','бар','pub','паб'],
        street:   ['street','улица','city','город','town','town square','площадь','market','рынок'],
        palace:   ['palace','дворец','castle','замок','throne','трон','court','двор'],
        forest:   ['forest','лес','woods','роща','clearing','поляна','path','тропа'],
        dungeon:  ['dungeon','подземелье','cave','пещера','ruins','руины','crypt','склеп'],
        home:     ['home','дом','house','комната','room','bedroom','спальня','cottage'],
        road:     ['road','дорога','highway','тракт','crossroads','перекрёсток','bridge','мост'],
    };
    const recentText = chatMessages.slice(-6).map(m => m.mes || '').join(' ').toLowerCase();
    for (const [loc, words] of Object.entries(keywords)) {
        if (words.some(w => recentText.includes(w))) return loc;
    }
    return 'unknown';
}

const LOCATION_FLAVOR = {
    tavern:  'a traveller, drunkard, merchant, bard, or bounty hunter',
    street:  'a courier, thief, town guard, vendor, or old acquaintance',
    palace:  'a courtier, spy, servant, ambassador, or noble',
    forest:  'a hunter, wandering hermit, bandit, lost traveller, or ranger',
    dungeon: 'a rival adventurer, trapped soul, cultist, or treasure seeker',
    home:    'a neighbour, delivery person, debt collector, or childhood friend',
    road:    'a wandering merchant, pilgrim, fleeing refugee, or mounted messenger',
    unknown: 'a stranger with their own agenda',
};

// ─── Weight selector ──────────────────────────────────────────────────────────
function rollNPCWeight(settings) {
    const r = Math.random() * 100;
    if (r < settings.npc_weight_minor) return 'minor';
    if (r < settings.npc_weight_minor + settings.npc_weight_hook) return 'hook';
    return 'major';
}

// ─── System prompt injections ─────────────────────────────────────────────────
function getKnowledgeSepInjection() {
    return `[WORLD RULE: ${getContext().name || 'The character'} has no knowledge of events or scenes they were not personally present in. They learn about off-screen events only if directly told. They do not omnisciently track the user's actions.]`;
}

// ─── Core generator functions ─────────────────────────────────────────────────

async function generateNPCEncounter(settings, chatMessages) {
    const { name, gender } = generateNPCName(settings);
    const location = settings.auto_detect_location
        ? detectLocation(chatMessages)
        : (settings.manual_location || 'unknown');
    const flavor = LOCATION_FLAVOR[location] || LOCATION_FLAVOR.unknown;
    const weight = rollNPCWeight(settings);
    const charName = getContext().name || 'the main character';

    const weightGuide = {
        minor: 'This NPC is a brief, passing presence. They add colour to the world but leave quickly. They have no deep connection to the main character.',
        hook:  'This NPC brings a small hook — a rumour, a problem, a request, or a secret. They may linger briefly.',
        major: 'This NPC is potentially significant. They have history, strong motivation, and could become a recurring presence in the story.',
    };

    const genderStr = gender === 'male' ? 'male' : 'female';

    const prompt = `You are a creative writing assistant for an RPG roleplay. Generate a spontaneous NPC who appears in the scene.

Setting location: ${location}
Appropriate NPC types for this location: ${flavor}
NPC gender: ${genderStr}
NPC name: ${name}
NPC significance: ${weight} — ${weightGuide[weight]}
Main character name (do NOT make this NPC focused on them): ${charName}

Respond ONLY with a JSON object, no markdown fences, no extra text:
{
  "name": "${name}",
  "gender": "${genderStr}",
  "appearance": "one vivid sentence",
  "occupation": "brief role/occupation",
  "reason_for_being_here": "their own business, unrelated to the main character",
  "personality_note": "one trait",
  "hook": "optional — a rumour, request, or secret they carry (empty string if minor NPC)",
  "narrative_intro": "2-3 sentences in third-person narration style, describing their entrance into the scene naturally"
}`;

    try {
        const raw = await generateQuietPrompt(prompt, false, false);
        const clean = raw.replace(/```json|```/gi, '').trim();
        const npc = JSON.parse(clean);
        npc.weight = weight;
        npc.location = location;
        return npc;
    } catch (e) {
        console.error(`[${EXT_NAME}] NPC generation failed:`, e);
        return null;
    }
}

async function generateOffscreenLife(settings) {
    const charName = getContext().name || 'the character';
    const count = settings.offscreen_events_count || 2;

    const prompt = `You are a creative writing assistant. Generate ${count} brief off-screen events that happened to "${charName}" while they were not in any scene with the player/user.

Rules:
- Events must be personal to ${charName}, not involving the user/player at all
- They can be mundane (business deal, argument with a neighbour, a dream) or significant (received a letter, made a new contact, lost something)
- Written in past tense, third person, 1-2 sentences each
- ${charName} does NOT know what the user has been doing

Respond ONLY with a JSON array, no markdown, no extra text:
[
  {"event": "...", "timeframe": "yesterday/this morning/a few days ago/last week"}
]`;

    try {
        const raw = await generateQuietPrompt(prompt, false, false);
        const clean = raw.replace(/```json|```/gi, '').trim();
        return JSON.parse(clean);
    } catch (e) {
        console.error(`[${EXT_NAME}] Offscreen generation failed:`, e);
        return null;
    }
}

async function generateAutonomyAction(settings) {
    const charName = getContext().name || 'the character';

    const prompt = `Write a single short autonomous action or inner thought for "${charName}" who is currently busy with their own life, not thinking about the user/player. 

1-2 sentences, third person, present or recent past tense. Should feel like a natural slice-of-life moment. Not dramatic, just real.`;

    try {
        return await generateQuietPrompt(prompt, false, false);
    } catch (e) {
        console.error(`[${EXT_NAME}] Autonomy action failed:`, e);
        return null;
    }
}

// ─── Lorebook saving ──────────────────────────────────────────────────────────
async function saveNPCToLorebook(npc) {
    try {
        const context = getContext();
        const bookName = `LivingWorld_NPCs`;

        // Check if lorebook exists, create if not
        let books = Object.keys(world_info?.entries || {});
        
        const entryContent = `NPC: ${npc.name} (${npc.gender}, ${npc.occupation})
Appearance: ${npc.appearance}
Personality: ${npc.personality_note}
Background reason: ${npc.reason_for_being_here}
${npc.hook ? `Hook/Secret: ${npc.hook}` : ''}
First seen: ${npc.location}
Significance: ${npc.weight}`;

        // Use ST's built-in world info API if available
        if (typeof window.createWorldInfoEntry === 'function') {
            await window.createWorldInfoEntry(bookName, {
                key: [npc.name],
                content: entryContent,
                comment: `Auto-generated NPC: ${npc.name}`,
                enabled: true,
            });
        } else {
            // Fallback: store in extension metadata
            const meta = context.chatMetadata?.living_world_npcs || {};
            meta[npc.name] = { ...npc, created: Date.now() };
            if (!context.chatMetadata) context.chatMetadata = {};
            context.chatMetadata.living_world_npcs = meta;
            saveMetadataDebounced();
        }
        console.log(`[${EXT_NAME}] Saved NPC "${npc.name}" to lorebook`);
    } catch (e) {
        console.warn(`[${EXT_NAME}] Could not save NPC to lorebook:`, e);
    }
}

// ─── Chat injection ───────────────────────────────────────────────────────────
async function injectNPCEncounter(npc, settings) {
    const context = getContext();
    
    if (settings.encounter_inject_style === 'narrative') {
        const injection = `\n\n[WORLD EVENT: ${npc.narrative_intro}${npc.hook ? ` ${npc.name} seems to carry something on their mind.` : ''}]\n`;
        // Add as a system injection to the next message context
        return injection;
    } else {
        // OOC style
        return `\n\n[OOC — Living World: A new character appears — **${npc.name}** (${npc.occupation}). ${npc.narrative_intro}]\n`;
    }
}

// ─── UI panel rendering ───────────────────────────────────────────────────────
function buildSettingsHTML() {
    const s = extension_settings[EXT_NAME];
    return `
<div id="lw-panel" style="padding:10px; font-family: var(--mainFontFamily, sans-serif);">
  <div style="display:flex; align-items:center; gap:8px; margin-bottom:12px;">
    <span style="font-size:18px;">🌍</span>
    <strong style="font-size:15px;">Living World</strong>
    <label style="margin-left:auto; display:flex; align-items:center; gap:5px; cursor:pointer;">
      <input type="checkbox" id="lw-enabled" ${s.enabled ? 'checked' : ''}>
      <span>Включено</span>
    </label>
  </div>

  <!-- NPC ENCOUNTERS -->
  <details open>
    <summary style="cursor:pointer; font-weight:bold; padding:4px 0; border-bottom:1px solid var(--SmartThemeBorderColor, #555); margin-bottom:8px;">
      🎲 Случайные НПС
    </summary>
    <div style="padding:6px 0; display:flex; flex-direction:column; gap:6px;">

      <label style="display:flex; align-items:center; gap:6px;">
        <input type="checkbox" id="lw-enc-enabled" ${s.encounters_enabled ? 'checked' : ''}>
        <span>Включить случайные встречи</span>
      </label>

      <div style="display:grid; grid-template-columns:1fr 1fr; gap:6px;">
        <div>
          <label style="font-size:12px; opacity:0.8;">Шанс появления (%)</label>
          <input type="number" id="lw-enc-chance" value="${s.encounter_chance}" min="1" max="100"
            style="width:100%; padding:3px 6px; border-radius:4px; border:1px solid var(--SmartThemeBorderColor, #555); background:var(--SmartThemeBlurTintColor, #222); color:inherit;">
        </div>
        <div>
          <label style="font-size:12px; opacity:0.8;">Проверка каждые N сообщений</label>
          <input type="number" id="lw-enc-every" value="${s.trigger_every_n}" min="1" max="50"
            style="width:100%; padding:3px 6px; border-radius:4px; border:1px solid var(--SmartThemeBorderColor, #555); background:var(--SmartThemeBlurTintColor, #222); color:inherit;">
        </div>
      </div>

      <div>
        <label style="font-size:12px; opacity:0.8;">Пол НПС по умолчанию</label>
        <select id="lw-gender"
          style="width:100%; padding:3px 6px; border-radius:4px; border:1px solid var(--SmartThemeBorderColor, #555); background:var(--SmartThemeBlurTintColor, #222); color:inherit;">
          <option value="random"  ${s.npc_gender==='random'  ? 'selected':''}>50/50 случайно</option>
          <option value="male"    ${s.npc_gender==='male'    ? 'selected':''}>Только мужские</option>
          <option value="female"  ${s.npc_gender==='female'  ? 'selected':''}>Только женские</option>
        </select>
      </div>

      <div>
        <label style="font-size:12px; opacity:0.8;">Стиль имён</label>
        <div style="display:flex; gap:6px; flex-wrap:wrap; margin-top:3px;">
          ${['english','russian','fantasy','mixed'].map(style => `
          <label style="display:flex; align-items:center; gap:4px; cursor:pointer; padding:3px 8px;
            border-radius:12px; border:1px solid var(--SmartThemeBorderColor, #555);
            background:${s.npc_name_style===style ? 'var(--SmartThemeQuoteColor, #4a6)' : 'transparent'};">
            <input type="radio" name="lw-namestyle" value="${style}" ${s.npc_name_style===style ? 'checked' : ''}
              style="display:none;">
            <span>${{english:'🇬🇧 Английские', russian:'🇷🇺 Русские', fantasy:'✨ Фэнтези', mixed:'🌐 Микс'}[style]}</span>
          </label>`).join('')}
        </div>
      </div>

      <div>
        <label style="font-size:12px; opacity:0.8; display:block; margin-bottom:3px;">Веса значимости (сумма ≈ 100)</label>
        <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:6px;">
          <div>
            <label style="font-size:11px; opacity:0.7;">Проходной %</label>
            <input type="number" id="lw-w-minor" value="${s.npc_weight_minor}" min="0" max="100"
              style="width:100%; padding:3px 6px; border-radius:4px; border:1px solid var(--SmartThemeBorderColor, #555); background:var(--SmartThemeBlurTintColor, #222); color:inherit;">
          </div>
          <div>
            <label style="font-size:11px; opacity:0.7;">С зацепкой %</label>
            <input type="number" id="lw-w-hook" value="${s.npc_weight_hook}" min="0" max="100"
              style="width:100%; padding:3px 6px; border-radius:4px; border:1px solid var(--SmartThemeBorderColor, #555); background:var(--SmartThemeBlurTintColor, #222); color:inherit;">
          </div>
          <div>
            <label style="font-size:11px; opacity:0.7;">Важный %</label>
            <input type="number" id="lw-w-major" value="${s.npc_weight_major}" min="0" max="100"
              style="width:100%; padding:3px 6px; border-radius:4px; border:1px solid var(--SmartThemeBorderColor, #555); background:var(--SmartThemeBlurTintColor, #222); color:inherit;">
          </div>
        </div>
      </div>

      <label style="display:flex; align-items:center; gap:6px;">
        <input type="checkbox" id="lw-autoloc" ${s.auto_detect_location ? 'checked' : ''}>
        <span>Авто-определение локации</span>
      </label>

      <div id="lw-manual-loc-wrap" style="${s.auto_detect_location ? 'display:none' : ''}">
        <label style="font-size:12px; opacity:0.8;">Локация вручную</label>
        <input type="text" id="lw-manual-loc" value="${s.manual_location}" placeholder="tavern, forest, palace..."
          style="width:100%; padding:3px 6px; border-radius:4px; border:1px solid var(--SmartThemeBorderColor, #555); background:var(--SmartThemeBlurTintColor, #222); color:inherit;">
      </div>

      <label style="display:flex; align-items:center; gap:6px;">
        <input type="checkbox" id="lw-save-lorebook" ${s.save_npcs_to_lorebook ? 'checked' : ''}>
        <span>Сохранять НПС в World Info</span>
      </label>

      <div>
        <label style="font-size:12px; opacity:0.8;">Стиль появления</label>
        <select id="lw-inject-style"
          style="width:100%; padding:3px 6px; border-radius:4px; border:1px solid var(--SmartThemeBorderColor, #555); background:var(--SmartThemeBlurTintColor, #222); color:inherit;">
          <option value="narrative" ${s.encounter_inject_style==='narrative' ? 'selected':''}>Нарратив (вшивается в мир)</option>
          <option value="ooc"       ${s.encounter_inject_style==='ooc'       ? 'selected':''}>OOC (за скобками)</option>
        </select>
      </div>

      <button id="lw-force-encounter" style="padding:5px 10px; border-radius:6px; cursor:pointer;
        background:var(--SmartThemeQuoteColor, #4a6); color:#fff; border:none; font-size:13px;">
        ⚡ Принудительная встреча сейчас
      </button>
    </div>
  </details>

  <!-- OFFSCREEN LIFE -->
  <details style="margin-top:8px;">
    <summary style="cursor:pointer; font-weight:bold; padding:4px 0; border-bottom:1px solid var(--SmartThemeBorderColor, #555); margin-bottom:8px;">
      🕰️ Жизнь за кадром
    </summary>
    <div style="display:flex; flex-direction:column; gap:6px; padding:6px 0;">
      <label style="display:flex; align-items:center; gap:6px;">
        <input type="checkbox" id="lw-offscreen-enabled" ${s.offscreen_enabled ? 'checked' : ''}>
        <span>Включить жизнь за кадром</span>
      </label>
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:6px;">
        <div>
          <label style="font-size:12px; opacity:0.8;">Обновлять каждые N сообщений</label>
          <input type="number" id="lw-offscreen-every" value="${s.offscreen_every_n}" min="5" max="100"
            style="width:100%; padding:3px 6px; border-radius:4px; border:1px solid var(--SmartThemeBorderColor, #555); background:var(--SmartThemeBlurTintColor, #222); color:inherit;">
        </div>
        <div>
          <label style="font-size:12px; opacity:0.8;">Количество событий</label>
          <input type="number" id="lw-offscreen-count" value="${s.offscreen_events_count}" min="1" max="5"
            style="width:100%; padding:3px 6px; border-radius:4px; border:1px solid var(--SmartThemeBorderColor, #555); background:var(--SmartThemeBlurTintColor, #222); color:inherit;">
        </div>
      </div>
    </div>
  </details>

  <!-- KNOWLEDGE SEPARATION -->
  <details style="margin-top:8px;">
    <summary style="cursor:pointer; font-weight:bold; padding:4px 0; border-bottom:1px solid var(--SmartThemeBorderColor, #555); margin-bottom:8px;">
      🧠 Разделение знаний
    </summary>
    <div style="padding:6px 0;">
      <label style="display:flex; align-items:center; gap:6px;">
        <input type="checkbox" id="lw-knowledge-enabled" ${s.knowledge_sep_enabled ? 'checked' : ''}>
        <span>Персонаж не знает о сценах без него</span>
      </label>
      <p style="font-size:11px; opacity:0.6; margin:4px 0 0 22px;">
        Автоматически добавляет системное правило о том, что персонаж не телепатически следит за игроком.
      </p>
    </div>
  </details>

  <!-- AUTONOMY TICK -->
  <details style="margin-top:8px;">
    <summary style="cursor:pointer; font-weight:bold; padding:4px 0; border-bottom:1px solid var(--SmartThemeBorderColor, #555); margin-bottom:8px;">
      🤖 Автономность персонажа
    </summary>
    <div style="display:flex; flex-direction:column; gap:6px; padding:6px 0;">
      <label style="display:flex; align-items:center; gap:6px;">
        <input type="checkbox" id="lw-autonomy-enabled" ${s.autonomy_enabled ? 'checked' : ''}>
        <span>Включить автономные действия</span>
      </label>
      <div>
        <label style="font-size:12px; opacity:0.8;">Каждые N сообщений</label>
        <input type="number" id="lw-autonomy-every" value="${s.autonomy_every_n}" min="5" max="100"
          style="width:100%; padding:3px 6px; border-radius:4px; border:1px solid var(--SmartThemeBorderColor, #555); background:var(--SmartThemeBlurTintColor, #222); color:inherit;">
      </div>
      <p style="font-size:11px; opacity:0.6; margin:0;">
        Периодически генерирует короткое действие персонажа, не связанное с игроком, и добавляет в контекст.
      </p>
    </div>
  </details>

  <!-- NPC LOG -->
  <details style="margin-top:8px;">
    <summary style="cursor:pointer; font-weight:bold; padding:4px 0; border-bottom:1px solid var(--SmartThemeBorderColor, #555); margin-bottom:8px;">
      📋 Встреченные НПС
    </summary>
    <div id="lw-npc-log" style="font-size:12px; max-height:200px; overflow-y:auto; padding:4px;">
      <em style="opacity:0.5;">Здесь появятся встреченные НПС...</em>
    </div>
    <button id="lw-clear-log" style="margin-top:6px; padding:4px 10px; border-radius:5px; cursor:pointer;
      background:transparent; border:1px solid var(--SmartThemeBorderColor, #555); color:inherit; font-size:12px;">
      🗑️ Очистить лог
    </button>
  </details>
</div>`;
}

// ─── Log management ───────────────────────────────────────────────────────────
function getLog() {
    const context = getContext();
    if (!context.chatMetadata) context.chatMetadata = {};
    return context.chatMetadata.lw_npc_log || [];
}

function addToLog(npc) {
    const context = getContext();
    if (!context.chatMetadata) context.chatMetadata = {};
    const log = context.chatMetadata.lw_npc_log || [];
    log.unshift({
        name: npc.name,
        occupation: npc.occupation,
        weight: npc.weight,
        location: npc.location,
        time: new Date().toLocaleTimeString(),
    });
    if (log.length > 50) log.pop();
    context.chatMetadata.lw_npc_log = log;
    saveMetadataDebounced();
    refreshLogUI();
}

function refreshLogUI() {
    const el = document.getElementById('lw-npc-log');
    if (!el) return;
    const log = getLog();
    if (!log.length) {
        el.innerHTML = '<em style="opacity:0.5;">Здесь появятся встреченные НПС...</em>';
        return;
    }
    const weightIcon = { minor:'⚪', hook:'🟡', major:'🔴' };
    el.innerHTML = log.map(n => `
      <div style="padding:3px 0; border-bottom:1px solid var(--SmartThemeBorderColor, #55555540);">
        ${weightIcon[n.weight]||'⚪'} <strong>${n.name}</strong> — ${n.occupation}
        <span style="opacity:0.5; font-size:11px;"> @ ${n.location} · ${n.time}</span>
      </div>`).join('');
}

// ─── Settings save ────────────────────────────────────────────────────────────
function saveSettings() {
    const s = extension_settings[EXT_NAME];

    s.enabled              = document.getElementById('lw-enabled')?.checked ?? s.enabled;
    s.encounters_enabled   = document.getElementById('lw-enc-enabled')?.checked ?? s.encounters_enabled;
    s.encounter_chance     = parseInt(document.getElementById('lw-enc-chance')?.value) || s.encounter_chance;
    s.trigger_every_n      = parseInt(document.getElementById('lw-enc-every')?.value)  || s.trigger_every_n;
    s.npc_gender           = document.getElementById('lw-gender')?.value ?? s.npc_gender;
    s.npc_name_style       = document.querySelector('input[name="lw-namestyle"]:checked')?.value ?? s.npc_name_style;
    s.npc_weight_minor     = parseInt(document.getElementById('lw-w-minor')?.value) || s.npc_weight_minor;
    s.npc_weight_hook      = parseInt(document.getElementById('lw-w-hook')?.value)  || s.npc_weight_hook;
    s.npc_weight_major     = parseInt(document.getElementById('lw-w-major')?.value) || s.npc_weight_major;
    s.auto_detect_location = document.getElementById('lw-autoloc')?.checked ?? s.auto_detect_location;
    s.manual_location      = document.getElementById('lw-manual-loc')?.value ?? s.manual_location;
    s.save_npcs_to_lorebook= document.getElementById('lw-save-lorebook')?.checked ?? s.save_npcs_to_lorebook;
    s.encounter_inject_style= document.getElementById('lw-inject-style')?.value ?? s.encounter_inject_style;
    s.offscreen_enabled    = document.getElementById('lw-offscreen-enabled')?.checked ?? s.offscreen_enabled;
    s.offscreen_every_n    = parseInt(document.getElementById('lw-offscreen-every')?.value) || s.offscreen_every_n;
    s.offscreen_events_count= parseInt(document.getElementById('lw-offscreen-count')?.value) || s.offscreen_events_count;
    s.knowledge_sep_enabled= document.getElementById('lw-knowledge-enabled')?.checked ?? s.knowledge_sep_enabled;
    s.autonomy_enabled     = document.getElementById('lw-autonomy-enabled')?.checked ?? s.autonomy_enabled;
    s.autonomy_every_n     = parseInt(document.getElementById('lw-autonomy-every')?.value) || s.autonomy_every_n;

    // update radio button styling
    document.querySelectorAll('input[name="lw-namestyle"]').forEach(r => {
        const label = r.closest('label');
        if (label) {
            label.style.background = r.checked
                ? 'var(--SmartThemeQuoteColor, #4a6)'
                : 'transparent';
        }
    });

    // toggle manual location field
    const wrap = document.getElementById('lw-manual-loc-wrap');
    if (wrap) wrap.style.display = s.auto_detect_location ? 'none' : '';

    saveSettingsDebounced();
}

function bindSettingsEvents() {
    const ids = [
        'lw-enabled','lw-enc-enabled','lw-enc-chance','lw-enc-every',
        'lw-gender','lw-w-minor','lw-w-hook','lw-w-major',
        'lw-autoloc','lw-manual-loc','lw-save-lorebook','lw-inject-style',
        'lw-offscreen-enabled','lw-offscreen-every','lw-offscreen-count',
        'lw-knowledge-enabled','lw-autonomy-enabled','lw-autonomy-every',
    ];
    ids.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('change', saveSettings);
        if (el?.type === 'number' || el?.type === 'text') el.addEventListener('input', saveSettings);
    });
    document.querySelectorAll('input[name="lw-namestyle"]').forEach(r => r.addEventListener('change', saveSettings));

    document.getElementById('lw-force-encounter')?.addEventListener('click', async () => {
        const btn = document.getElementById('lw-force-encounter');
        if (btn) { btn.disabled = true; btn.textContent = '⏳ Генерирую...'; }
        await triggerEncounter(true);
        if (btn) { btn.disabled = false; btn.textContent = '⚡ Принудительная встреча сейчас'; }
    });

    document.getElementById('lw-clear-log')?.addEventListener('click', () => {
        const context = getContext();
        if (context.chatMetadata) context.chatMetadata.lw_npc_log = [];
        saveMetadataDebounced();
        refreshLogUI();
    });
}

// ─── Encounter trigger ────────────────────────────────────────────────────────
let _pendingInjection = null; // will be consumed on next PROMPT_READY

async function triggerEncounter(force = false) {
    const s = extension_settings[EXT_NAME];
    if (!s.enabled || !s.encounters_enabled) return;

    const context = getContext();
    const chat = context.chat || [];

    const npc = await generateNPCEncounter(s, chat);
    if (!npc) return;

    const injection = await injectNPCEncounter(npc, s);
    _pendingInjection = injection;

    addToLog(npc);

    if (s.save_npcs_to_lorebook) {
        await saveNPCToLorebook(npc);
    }

    // Show toast notification
    toastr.info(`🎲 ${npc.weight === 'major' ? '🔴' : npc.weight === 'hook' ? '🟡' : '⚪'} НПС появился: ${npc.name} (${npc.occupation})`, EXT_DISPLAY, { timeOut: 4000 });
}

// ─── Offscreen life trigger ───────────────────────────────────────────────────
let _offscreenLore = [];

async function triggerOffscreenLife() {
    const s = extension_settings[EXT_NAME];
    if (!s.enabled || !s.offscreen_enabled) return;

    const events = await generateOffscreenLife(s);
    if (!events || !events.length) return;

    _offscreenLore = events;

    const charName = getContext().name || 'the character';
    const summary  = events.map(e => `[${e.timeframe}] ${e.event}`).join(' ');
    console.log(`[${EXT_NAME}] Offscreen life for ${charName}:`, summary);

    toastr.info(`🕰️ Жизнь за кадром обновлена (${events.length} событий)`, EXT_DISPLAY, { timeOut: 3000 });
}

// ─── Autonomy tick ────────────────────────────────────────────────────────────
let _autonomyText = null;

async function triggerAutonomy() {
    const s = extension_settings[EXT_NAME];
    if (!s.enabled || !s.autonomy_enabled) return;

    const action = await generateAutonomyAction(s);
    if (!action) return;

    _autonomyText = action.trim();
    console.log(`[${EXT_NAME}] Autonomy:`, _autonomyText);
}

// ─── Prompt injection hook ────────────────────────────────────────────────────
function onPromptReady(data) {
    const s = extension_settings[EXT_NAME];
    if (!s.enabled) return;

    let extraSystem = '';

    // 1. Knowledge separation
    if (s.knowledge_sep_enabled) {
        extraSystem += '\n' + getKnowledgeSepInjection();
    }

    // 2. Offscreen lore injection
    if (_offscreenLore.length) {
        const charName = getContext().name || 'the character';
        const lore = _offscreenLore.map(e => `[${e.timeframe}] ${e.event}`).join(' ');
        extraSystem += `\n[OFFSCREEN LOG for ${charName}: ${lore}]`;
        _offscreenLore = [];
    }

    // 3. Autonomy note
    if (_autonomyText) {
        extraSystem += `\n[AUTONOMY NOTE: ${_autonomyText}]`;
        _autonomyText = null;
    }

    // 4. NPC encounter injection
    if (_pendingInjection) {
        extraSystem += _pendingInjection;
        _pendingInjection = null;
    }

    // Inject into system prompt slot
    if (extraSystem && data?.chat) {
        // Find existing system message or inject at beginning
        const systemMsg = data.chat.find(m => m.role === 'system');
        if (systemMsg) {
            systemMsg.content += extraSystem;
        } else {
            data.chat.unshift({ role: 'system', content: extraSystem.trim() });
        }
    }
}

// ─── Message counter hook ─────────────────────────────────────────────────────
async function onMessageReceived() {
    const s = extension_settings[EXT_NAME];
    if (!s.enabled) return;

    s._msg_counter      = (s._msg_counter      || 0) + 1;
    s._offscreen_counter= (s._offscreen_counter || 0) + 1;
    s._autonomy_counter = (s._autonomy_counter  || 0) + 1;

    // Encounter check
    if (s.encounters_enabled && s._msg_counter >= s.trigger_every_n) {
        s._msg_counter = 0;
        if (Math.random() * 100 < s.encounter_chance) {
            await triggerEncounter();
        }
    }

    // Offscreen life check
    if (s.offscreen_enabled && s._offscreen_counter >= s.offscreen_every_n) {
        s._offscreen_counter = 0;
        await triggerOffscreenLife();
    }

    // Autonomy tick
    if (s.autonomy_enabled && s._autonomy_counter >= s.autonomy_every_n) {
        s._autonomy_counter = 0;
        await triggerAutonomy();
    }

    saveSettingsDebounced();
}

// ─── Extension init ───────────────────────────────────────────────────────────
jQuery(async () => {
    // Init settings
    if (!extension_settings[EXT_NAME]) {
        extension_settings[EXT_NAME] = { ...DEFAULT_SETTINGS };
    }
    // Merge any missing keys
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
        if (extension_settings[EXT_NAME][k] === undefined) {
            extension_settings[EXT_NAME][k] = v;
        }
    }

    // Register panel in Extensions tab
    const settingsHtml = `
      <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
          <b>🌍 Living World</b>
          <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content" id="living-world-settings">
        </div>
      </div>`;

    $('#extensions_settings').append(settingsHtml);
    $('#living-world-settings').html(buildSettingsHTML());
    bindSettingsEvents();
    refreshLogUI();

    // Hook into SillyTavern events
    eventSource.on(event_types.MESSAGE_RECEIVED,         onMessageReceived);
    eventSource.on(event_types.MESSAGE_SENT,             onMessageReceived);
    eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, onPromptReady);

    // Re-render settings when chat changes (preserves log)
    eventSource.on(event_types.CHAT_CHANGED, () => {
        const el = document.getElementById('living-world-settings');
        if (el) {
            el.innerHTML = buildSettingsHTML();
            bindSettingsEvents();
            refreshLogUI();
        }
    });

    console.log(`[${EXT_NAME}] Living World extension loaded ✓`);
});
