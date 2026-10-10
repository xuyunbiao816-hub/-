"use strict";

const DATA_URL = "data/words.json";
const EXPECTED_COUNT = 993;
const PROGRESS_KEY = "sihai-1000-progress-v1";
const DAILY_KEY = "sihai-1000-daily-v1";
const SPEECH_SETTINGS_KEY = "sihai-1000-speech-v1";
const SPEECH_RATES = [0.75, 0.9, 1.05, 1.2];
const DEFAULT_SPEECH_SETTINGS = {
  enabled: true,
  autoWord: true,
  autoAnswer: true,
  rate: 0.9,
  voiceURI: ""
};

let words = [];
let itemById = new Map();
let progress = {};
let dailyPlan = { date: "", ids: [] };
let reviewSession = null;
let newSession = null;
let wrongSession = null;
let activeStudyMode = null;
let detailItem = null;
let toastTimer = null;
let speechSettings = loadSpeechSettings();
let chineseVoice = null;
const speechSupported = "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;

const $ = (selector, scope = document) => scope.querySelector(selector);
const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];
const recordId = item => String(item.记录ID);

document.addEventListener("DOMContentLoaded", init);

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(error => {
      console.warn("离线功能注册失败，当前仍可在线使用。", error);
    });
  });
}

async function init() {
  bindStaticEvents();
  initializeSpeech();
  syncSpeechSettingsUi();
  $("#today-label").textContent = new Intl.DateTimeFormat("zh-CN", {
    month: "long", day: "numeric", weekday: "short"
  }).format(new Date());

  try {
    const response = await fetch(DATA_URL, { cache: "no-store" });
    if (!response.ok) throw new Error(`题库请求失败：${response.status}`);
    const data = await response.json();
    if (!Array.isArray(data.items) || data.items.length !== EXPECTED_COUNT) {
      throw new Error(`题库记录数不是 ${EXPECTED_COUNT} 条`);
    }
    const ids = data.items.map(recordId);
    if (ids.some(id => !id) || new Set(ids).size !== EXPECTED_COUNT) {
      throw new Error("记录ID存在空值或重复值");
    }
    words = data.items;
    itemById = new Map(words.map(item => [recordId(item), item]));
    progress = loadProgress();
    dailyPlan = loadDailyPlan();
    ensureDailyPlan();
    populateGroups();
    rebuildTodaySessions();
    renderAll();
  } catch (error) {
    console.error(error);
    $("#today-study-host").innerHTML = `<div class="empty-state"><h3>题库读取失败</h3><p>请确认通过本地服务器启动，且 data/words.json 完整可用。</p></div>`;
  }
}

function bindStaticEvents() {
  $$(".nav-button").forEach(button => button.addEventListener("click", () => switchView(button.dataset.view)));
  $("#word-search").addEventListener("input", renderLibrary);
  $("#type-filter").addEventListener("change", renderLibrary);
  $("#group-filter").addEventListener("change", renderLibrary);
  $("#start-review-study").addEventListener("click", () => chooseStudyMode("review"));
  $("#start-new-study").addEventListener("click", chooseNewStudy);
  $("#start-wrong-review").addEventListener("click", startWrongReview);
  $("#export-progress").addEventListener("click", exportProgress);
  $("#import-progress").addEventListener("change", importProgress);
  $("#reset-progress").addEventListener("click", resetProgress);
  $("#close-dialog").addEventListener("click", () => $("#detail-dialog").close());
  $("#detail-wrong-toggle").addEventListener("click", () => {
    if (!detailItem) return;
    toggleWrong(recordId(detailItem));
    updateDetailWrongButton();
  });
  $("#speech-enabled").addEventListener("change", event => {
    speechSettings.enabled = event.currentTarget.checked;
    if (!speechSettings.enabled) stopSpeech();
    saveSpeechSettings();
    syncSpeechSettingsUi();
  });
  $("#speech-auto-word").addEventListener("change", event => {
    speechSettings.autoWord = event.currentTarget.checked;
    saveSpeechSettings();
  });
  $("#speech-auto-answer").addEventListener("change", event => {
    speechSettings.autoAnswer = event.currentTarget.checked;
    saveSpeechSettings();
  });
  $("#speech-rate").addEventListener("change", event => {
    const rate = Number(event.currentTarget.value);
    speechSettings.rate = SPEECH_RATES.includes(rate) ? rate : DEFAULT_SPEECH_SETTINGS.rate;
    saveSpeechSettings();
  });
  $("#speech-voice").addEventListener("change", event => {
    speechSettings.voiceURI = event.currentTarget.value;
    stopSpeech();
    refreshChineseVoice();
    saveSpeechSettings();
    syncSpeechSettingsUi();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopSpeech();
  });
  window.addEventListener("pagehide", stopSpeech);
}

function loadSpeechSettings() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SPEECH_SETTINGS_KEY) || "{}");
    const rate = Number(parsed.rate);
    return {
      enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : DEFAULT_SPEECH_SETTINGS.enabled,
      autoWord: typeof parsed.autoWord === "boolean" ? parsed.autoWord : DEFAULT_SPEECH_SETTINGS.autoWord,
      autoAnswer: typeof parsed.autoAnswer === "boolean" ? parsed.autoAnswer : DEFAULT_SPEECH_SETTINGS.autoAnswer,
      rate: SPEECH_RATES.includes(rate) ? rate : DEFAULT_SPEECH_SETTINGS.rate,
      voiceURI: typeof parsed.voiceURI === "string" ? parsed.voiceURI : DEFAULT_SPEECH_SETTINGS.voiceURI
    };
  } catch {
    return { ...DEFAULT_SPEECH_SETTINGS };
  }
}

function saveSpeechSettings() {
  localStorage.setItem(SPEECH_SETTINGS_KEY, JSON.stringify(speechSettings));
}

function initializeSpeech() {
  if (!speechSupported) return;
  updateAvailableVoices();
  window.speechSynthesis.addEventListener("voiceschanged", updateAvailableVoices);
}

function refreshChineseVoice() {
  if (!speechSupported) return;
  const voices = window.speechSynthesis.getVoices();
  const selected = speechSettings.voiceURI
    ? voices.find(voice => voice.voiceURI === speechSettings.voiceURI)
    : null;
  if (selected) {
    chineseVoice = selected;
    return;
  }
  const chineseVoices = voices.filter(voice => voice.lang.toLowerCase().startsWith("zh"));
  chineseVoice = chineseVoices.sort((left, right) => voiceScore(right) - voiceScore(left))[0] || null;
}

function voiceScore(voice) {
  const lang = voice.lang.toLowerCase();
  const name = voice.name.toLowerCase();
  let score = lang === "zh-cn" ? 100 : lang.startsWith("zh-hans") ? 90 : 60;
  if (voice.localService) score += 20;
  if (/xiaoxiao|晓晓|普通话|putonghua|mandarin/.test(name)) score += 25;
  if (/natural|自然/.test(name)) score += 10;
  if (/huihui|慧慧/.test(name)) score += 15;
  if (/yaoyao|瑶瑶/.test(name)) score += 10;
  if (/kangkang|康康/.test(name)) score -= 5;
  return score;
}

function updateAvailableVoices() {
  refreshChineseVoice();
  populateVoiceOptions();
  syncSpeechSettingsUi();
}

function populateVoiceOptions() {
  const select = $("#speech-voice");
  if (!select || !speechSupported) return;
  const voices = window.speechSynthesis.getVoices();
  const chineseVoices = voices.filter(voice => voice.lang.toLowerCase().startsWith("zh"));
  const available = (chineseVoices.length ? chineseVoices : voices)
    .sort((left, right) => voiceScore(right) - voiceScore(left));
  const recommendedVoiceURI = available[0]?.voiceURI || "";
  select.replaceChildren();
  const automatic = document.createElement("option");
  automatic.value = "";
  automatic.textContent = "自动选择";
  select.append(automatic);
  available.forEach(voice => {
      const option = document.createElement("option");
      option.value = voice.voiceURI;
      const recommendation = voice.voiceURI === recommendedVoiceURI ? " · 推荐" : "";
      option.textContent = `${voice.name}（${voice.lang}）${recommendation}`;
      select.append(option);
    });
  select.value = available.some(voice => voice.voiceURI === speechSettings.voiceURI)
    ? speechSettings.voiceURI
    : "";
}

function stopSpeech() {
  if (speechSupported) window.speechSynthesis.cancel();
}

function speakText(text) {
  if (!speechSupported || !speechSettings.enabled) return;
  window.speechSynthesis.cancel();
  const content = String(text || "").trim();
  if (!content) return;
  refreshChineseVoice();
  const utterance = new window.SpeechSynthesisUtterance(content);
  utterance.lang = "zh-CN";
  utterance.rate = speechSettings.rate;
  utterance.pitch = 1;
  utterance.volume = 1;
  if (chineseVoice) utterance.voice = chineseVoice;
  window.speechSynthesis.speak(utterance);
}

function speakWord(item) {
  const word = String(item["词语"] || "").trim();
  speakText(word ? `${word}。` : "");
}

function speakAnswer(item) {
  const definition = String(item["说人话"] || item["原书释义"] || "").trim();
  speakText(definition ? (/[。！？；!?]$/.test(definition) ? definition : `${definition}。`) : "");
}

function syncCardSpeechUi(scope = document) {
  $$(".speech-read-button, .example-speech-button", scope).forEach(button => {
    button.hidden = !speechSupported;
    button.disabled = !speechSettings.enabled;
  });
  $$(".speech-unavailable", scope).forEach(note => {
    note.hidden = speechSupported;
  });
}

function syncSpeechSettingsUi() {
  const enabled = $("#speech-enabled");
  const autoWord = $("#speech-auto-word");
  const autoAnswer = $("#speech-auto-answer");
  const rate = $("#speech-rate");
  const voice = $("#speech-voice");
  enabled.checked = speechSettings.enabled;
  autoWord.checked = speechSettings.autoWord;
  autoAnswer.checked = speechSettings.autoAnswer;
  rate.value = String(speechSettings.rate);
  enabled.disabled = !speechSupported;
  autoWord.disabled = !speechSupported || !speechSettings.enabled;
  autoAnswer.disabled = !speechSupported || !speechSettings.enabled;
  rate.disabled = !speechSupported || !speechSettings.enabled;
  voice.disabled = !speechSupported || !speechSettings.enabled;
  if (speechSupported && voice.options.length) {
    voice.value = [...voice.options].some(option => option.value === speechSettings.voiceURI)
      ? speechSettings.voiceURI
      : "";
  }
  $("#speech-support-note").textContent = speechSupported
    ? chineseVoice
      ? `当前音色：${chineseVoice.name}。如果发音不自然，可换一个中文音色。`
      : "没有检测到中文音色，将使用系统默认音色。"
    : "当前浏览器不支持原生朗读，学习功能仍可正常使用。";
  syncCardSpeechUi();
}

function switchView(name) {
  stopSpeech();
  $$(".nav-button").forEach(button => {
    const active = button.dataset.view === name;
    button.classList.toggle("is-active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  $$(".view").forEach(view => {
    const active = view.id === `view-${name}`;
    view.hidden = !active;
    view.classList.toggle("is-active", active);
  });
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function localDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addDays(dateString, days) {
  const [year, month, day] = dateString.split("-").map(Number);
  const date = new Date(year, month - 1, day, 12);
  date.setDate(date.getDate() + days);
  return localDate(date);
}

function defaultRecord() {
  return {
    studied: false,
    lastStudyDate: null,
    nextReviewDate: null,
    intervalDays: 0,
    reviewCount: 0,
    dontKnowCount: 0,
    inWrongBook: false
  };
}

function validDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function clampInteger(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

function sanitizeRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return defaultRecord();
  return {
    studied: Boolean(value.studied),
    lastStudyDate: validDate(value.lastStudyDate) ? value.lastStudyDate : null,
    nextReviewDate: validDate(value.nextReviewDate) ? value.nextReviewDate : null,
    intervalDays: clampInteger(value.intervalDays, 0, 60),
    reviewCount: clampInteger(value.reviewCount, 0, 1000000),
    dontKnowCount: clampInteger(value.dontKnowCount, 0, 1000000),
    inWrongBook: Boolean(value.inWrongBook)
  };
}

function recordFor(id) {
  return progress[id] || defaultRecord();
}

function loadProgress() {
  try {
    const parsed = JSON.parse(localStorage.getItem(PROGRESS_KEY) || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const result = {};
    Object.entries(parsed).forEach(([id, value]) => {
      if (itemById.has(id)) result[id] = sanitizeRecord(value);
    });
    return result;
  } catch (error) {
    console.warn("本地学习进度无法读取，已使用空进度。", error);
    return {};
  }
}

function saveProgress() {
  localStorage.setItem(PROGRESS_KEY, JSON.stringify(progress));
}

function loadDailyPlan() {
  try {
    const parsed = JSON.parse(localStorage.getItem(DAILY_KEY) || "{}");
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.ids)) return { date: "", ids: [] };
    return {
      date: validDate(parsed.date) ? parsed.date : "",
      ids: [...new Set(parsed.ids.filter(id => itemById.has(id)))].slice(0, EXPECTED_COUNT)
    };
  } catch {
    return { date: "", ids: [] };
  }
}

function saveDailyPlan() {
  localStorage.setItem(DAILY_KEY, JSON.stringify(dailyPlan));
}

function ensureDailyPlan() {
  const today = localDate();
  if (dailyPlan.date === today) return;
  dailyPlan = {
    date: today,
    ids: words.filter(item => !recordFor(recordId(item)).studied).slice(0, 20).map(recordId)
  };
  saveDailyPlan();
}

function dueIds() {
  const today = localDate();
  return words.filter(item => {
    const record = recordFor(recordId(item));
    return record.studied && record.nextReviewDate && record.nextReviewDate <= today;
  }).map(recordId);
}

function newIdsForToday() {
  return dailyPlan.ids.filter(id => !recordFor(id).studied);
}

function rebuildTodaySessions() {
  reviewSession = { queue: dueIds(), completed: 0 };
  newSession = { queue: newIdsForToday(), completed: 0 };
  activeStudyMode = null;
}

function hasMoreNewWords() {
  const planned = new Set(dailyPlan.ids);
  return words.some(item => {
    const id = recordId(item);
    return !recordFor(id).studied && !planned.has(id);
  });
}

function addNewBatch() {
  const planned = new Set(dailyPlan.ids);
  const nextIds = words.filter(item => {
    const id = recordId(item);
    return !recordFor(id).studied && !planned.has(id);
  }).slice(0, 20).map(recordId);
  if (nextIds.length === 0) {
    showToast("没有更多未学习的新词");
    renderToday();
    return;
  }
  dailyPlan.ids.push(...nextIds);
  saveDailyPlan();
  newSession = { queue: nextIds, completed: 0 };
  activeStudyMode = "new";
  renderStats();
  renderToday();
  showToast(`已加入新一批 ${nextIds.length} 条`);
}

function chooseStudyMode(mode) {
  const session = mode === "review" ? reviewSession : newSession;
  if (!session || session.queue.length === 0) return;
  activeStudyMode = mode;
  renderToday();
  $("#today-study-host").scrollIntoView({ behavior: "smooth", block: "start" });
}

function chooseNewStudy() {
  if (newSession && newSession.queue.length > 0) chooseStudyMode("new");
  else if (hasMoreNewWords()) addNewBatch();
}

function renderAll() {
  renderStats();
  renderToday();
  renderWrongList();
  renderWrongPractice();
  renderLibrary();
}

function renderStats() {
  const records = words.map(item => recordFor(recordId(item)));
  const reviewPending = reviewSession ? reviewSession.queue.length : 0;
  const newPending = newSession ? newSession.queue.length : 0;
  $("#stat-today").textContent = reviewPending + newPending;
  $("#stat-learned").textContent = records.filter(record => record.studied).length;
  $("#stat-mastered").textContent = records.filter(record => record.studied && record.intervalDays >= 7).length;
  $("#stat-wrong").textContent = records.filter(record => record.inWrongBook).length;
}

function renderToday() {
  const host = $("#today-study-host");
  const reviewCount = reviewSession ? reviewSession.queue.length : 0;
  const newCount = newSession ? newSession.queue.length : 0;
  const moreNew = hasMoreNewWords();
  const batchNumber = Math.max(1, Math.ceil(dailyPlan.ids.length / 20));

  $("#today-queue-note").textContent = `复习 ${reviewCount} · 本批新词 ${newCount}`;
  $("#review-pending").textContent = reviewCount;
  $("#new-pending").textContent = newCount;
  $("#review-module").classList.toggle("is-active", activeStudyMode === "review");
  $("#new-module").classList.toggle("is-active", activeStudyMode === "new");

  const reviewButton = $("#start-review-study");
  reviewButton.disabled = reviewCount === 0;
  reviewButton.textContent = reviewCount === 0 ? "暂无到期复习" : activeStudyMode === "review" ? "继续复习" : "开始复习";
  $("#review-module-status").textContent = reviewCount === 0
    ? "当前没有到期记录，可先学习新词。"
    : `有 ${reviewCount} 条记录已到复习日期。`;

  const newButton = $("#start-new-study");
  newButton.disabled = newCount === 0 && !moreNew;
  if (newCount > 0) newButton.textContent = activeStudyMode === "new" ? "继续新词" : "开始新词";
  else if (moreNew) newButton.textContent = "再学 20 条新词";
  else newButton.textContent = "全部词语已学完";
  $("#new-module-status").textContent = newCount > 0
    ? `第 ${batchNumber} 批剩余 ${newCount} 条。`
    : moreNew ? `第 ${batchNumber} 批已完成，可自主开启下一批。` : `${EXPECTED_COUNT} 条已全部学习。`;

  const activeLabel = $("#active-study-label");
  if (!activeStudyMode) {
    activeLabel.hidden = true;
    host.innerHTML = `<div class="empty-state"><h3>选择学习内容</h3><p>你可以先复习，也可以先学习本批新词，两个队列可随时切换。</p></div>`;
    return;
  }

  const session = activeStudyMode === "review" ? reviewSession : newSession;
  const modeName = activeStudyMode === "review" ? "到期复习" : "新词学习";
  activeLabel.hidden = false;
  activeLabel.textContent = `正在进行：${modeName}`;
  if (!session || session.queue.length === 0) {
    host.innerHTML = activeStudyMode === "review"
      ? `<div class="empty-state"><h3>到期复习完成</h3><p>可以切换到新词学习。</p></div>`
      : `<div class="empty-state"><h3>本批新词完成</h3><p>${moreNew ? "可点击上方“再学 20 条新词”继续。" : `${EXPECTED_COUNT} 条已全部学习。`}</p></div>`;
    return;
  }
  const id = session.queue[0];
  const total = session.completed + session.queue.length;
  const mode = activeStudyMode;
  renderStudyCard(host, itemById.get(id), `${session.completed + 1} / ${total}`, rating => rateToday(mode, id, rating));
}

function makeTypeBadge(type) {
  const span = document.createElement("span");
  span.className = `type-badge ${type === "实词" ? "type-word" : "type-idiom"}`;
  span.textContent = type;
  return span;
}

function shortCoreMeaning(item) {
  const plain = String(item.说人话 || "").trim();
  if (plain) return plain;
  const definition = String(item.原书释义 || "").trim();
  const firstSentence = definition.match(/^.*?[。！？；]/);
  return firstSentence ? firstSentence[0] : definition;
}

function similarWordsFor(item) {
  if (Array.isArray(item.similarWords)) {
    return item.similarWords.map(value => String(value || "").trim()).filter(Boolean);
  }
  const single = String(item.similarWords || "").trim();
  return single ? [single] : [];
}

function reviewQuestionFor(item) {
  const examples = [item.例句1, item.例句2, item.例句3]
    .map(value => String(value || "").trim())
    .filter(Boolean);
  const context = examples[0] || `“${item.词语}”`;
  const similarWord = similarWordsFor(item).find(word => word !== item.词语);
  if (similarWord && context.includes(item.词语)) {
    const options = [item.词语, similarWord];
    if (Number(item.序号) % 2 === 0) options.reverse();
    return {
      kind: "近义词辨析",
      title: "这个语境中，哪个词更合适？",
      context: context.replace(item.词语, "____"),
      options,
      correct: item.词语
    };
  }
  return {
    kind: "语境判断",
    title: `下面句子中使用“${item.词语}”是否合适？`,
    context,
    options: ["适合", "不适合"],
    correct: "适合"
  };
}

function renderReviewQuestion(card, item, answer) {
  const question = reviewQuestionFor(item);
  const questionBlock = $(".review-question", card);
  questionBlock.hidden = false;
  $(".review-question-kind", card).textContent = question.kind;
  $(".review-question-title", card).textContent = question.title;
  $(".review-context", card).textContent = question.context;

  const optionsHost = $(".review-options", card);
  question.options.forEach(option => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "review-option button";
    button.textContent = option;
    button.addEventListener("click", () => {
      const correct = option === question.correct;
      $$(".review-option", optionsHost).forEach(candidate => {
        candidate.disabled = true;
        if (candidate.textContent === question.correct) candidate.classList.add("is-correct");
      });
      if (!correct) button.classList.add("is-wrong");
      const result = $(".review-result", card);
      result.hidden = false;
      result.classList.toggle("is-correct", correct);
      result.classList.toggle("is-wrong", !correct);
      result.textContent = correct ? "判断正确" : `正确答案：${question.correct}`;
      answer.hidden = false;
      if (speechSettings.enabled && speechSettings.autoAnswer) speakText(shortCoreMeaning(item));
      $("[data-rating]", answer).focus();
    });
    optionsHost.append(button);
  });
}

function renderStudyCard(host, item, progressText, onRate) {
  stopSpeech();
  host.replaceChildren();
  const fragment = $("#study-card-template").content.cloneNode(true);
  const card = $(".study-card", fragment);
  $(".study-badges", card).append(makeTypeBadge(item.类型));
  $(".study-group", card).textContent = `${item.册别} · 第${item.组别}组 · ${item.组名}`;
  $(".study-category", card).textContent = item.小分类;
  $(".study-progress", card).textContent = `当前进度 ${progressText}`;
  $(".study-record-id", card).textContent = item.记录ID;
  $(".study-idiom", card).textContent = item.词语;
  const plain = String(item.说人话 || "").trim();
  if (plain) {
    $(".study-plain-block", card).hidden = false;
    $(".study-plain-definition", card).textContent = plain;
  }
  $(".study-original-definition", card).open = !plain;
  $(".study-definition", card).textContent = item.原书释义;
  const tipBlock = $(".study-tip-block", card);
  if (String(item.使用提示 || "").trim()) {
    tipBlock.hidden = false;
    $(".study-tip", card).textContent = item.使用提示;
  }
  const examples = [item.例句1, item.例句2, item.例句3].filter(value => String(value || "").trim()).slice(0, 3);
  const exampleList = $(".study-examples", card);
  examples.forEach((example, index) => {
    const li = document.createElement("li");
    const text = document.createElement("span");
    text.textContent = example;
    const readExample = document.createElement("button");
    readExample.type = "button";
    readExample.className = "example-speech-button";
    readExample.textContent = "🔊";
    readExample.setAttribute("aria-label", `朗读第${index + 1}条例句`);
    readExample.title = `朗读第${index + 1}条例句`;
    readExample.addEventListener("click", () => speakText(example));
    li.append(text, readExample);
    exampleList.append(li);
  });
  if (examples.length === 0) $(".study-examples-block", card).hidden = true;
  $(".study-page", card).textContent = `来源页码：${item.册别}资料第 ${item.资料页码} 页（PDF 第 ${item.PDF页序} 页）`;

  const id = recordId(item);
  const wrongButton = $(".study-wrong-toggle", card);
  updateWrongButton(wrongButton, id);
  wrongButton.addEventListener("click", () => {
    toggleWrong(id);
    updateWrongButton(wrongButton, id);
  });

  const reveal = $(".reveal-button", card);
  const answer = $(".study-answer", card);
  const readButton = $(".speech-read-button", card);
  readButton.addEventListener("click", () => speakAnswer(item));
  syncCardSpeechUi(card);
  const isIdiomReview = item.类型 === "成语" && recordFor(id).studied;
  if (isIdiomReview) {
    $(".front-prompt", card).hidden = true;
    reveal.hidden = true;
    $(".study-full-answer", card).hidden = true;
    const summary = $(".review-answer-summary", card);
    summary.hidden = false;
    if (plain) {
      $(".review-core-block", summary).classList.add("plain-meaning-block");
      $(".review-core-title", summary).textContent = "说人话";
    }
    $(".review-core-meaning", summary).textContent = shortCoreMeaning(item);
    $(".review-original-text", summary).textContent = item.原书释义;
    $(".review-emphasis", summary).textContent = String(item.使用提示 || item.小分类 || "").trim();
    const contrast = String(item.contrast || "").trim();
    if (contrast) {
      $(".review-contrast-block", summary).hidden = false;
      $(".review-contrast", summary).textContent = contrast;
    }
    renderReviewQuestion(card, item, answer);
  } else {
    reveal.addEventListener("click", () => {
      answer.hidden = false;
      reveal.hidden = true;
      if (speechSettings.enabled && speechSettings.autoAnswer) speakAnswer(item);
      $("[data-rating]", answer).focus();
    });
  }
  $$('[data-rating]', card).forEach(button => button.addEventListener("click", () => onRate(button.dataset.rating)));
  host.append(fragment);
  if (speechSettings.enabled && speechSettings.autoWord) speakWord(item);
}

function rateToday(mode, id, rating) {
  const wasStudied = recordFor(id).studied;
  applyRating(id, rating);
  const session = mode === "review" ? reviewSession : newSession;
  session.queue.shift();
  session.completed += 1;
  if (mode === "new" && !wasStudied && rating === "again") session.queue.push(id);
  renderStats();
  renderToday();
  renderWrongList();
  renderLibrary();
}

function applyRating(id, rating) {
  stopSpeech();
  const record = { ...recordFor(id) };
  const wasStudied = record.studied;
  let interval;
  if (!wasStudied) interval = { again: 1, fuzzy: 1, good: 3, easy: 7 }[rating];
  else if (rating === "again") interval = 1;
  else if (rating === "fuzzy") interval = 2;
  else if (rating === "good") interval = Math.min(Math.max(record.intervalDays, 1) * 2, 30);
  else interval = Math.min(Math.max(record.intervalDays, 1) * 3, 60);

  record.studied = true;
  record.lastStudyDate = localDate();
  record.nextReviewDate = addDays(localDate(), interval);
  record.intervalDays = interval;
  record.reviewCount += 1;
  if (rating === "again") {
    record.dontKnowCount += 1;
    record.inWrongBook = true;
  }
  progress[id] = record;
  saveProgress();
  showToast(`${itemById.get(id).词语}：下次复习 ${record.nextReviewDate}`);
}

function updateWrongButton(button, id) {
  const active = recordFor(id).inWrongBook;
  button.textContent = active ? "移出错词本" : "加入错词本";
  button.setAttribute("aria-pressed", String(active));
}

function toggleWrong(id) {
  const record = { ...recordFor(id) };
  record.inWrongBook = !record.inWrongBook;
  progress[id] = record;
  saveProgress();
  renderStats();
  renderWrongList();
  renderLibrary();
  const label = itemById.get(id).词语;
  showToast(record.inWrongBook ? `已将“${label}”加入错词本` : `已将“${label}”移出错词本`);
}

function wrongItems() {
  return words.filter(item => recordFor(recordId(item)).inWrongBook);
}

function renderWrongList() {
  const list = $("#wrong-list");
  const items = wrongItems();
  $("#start-wrong-review").disabled = items.length === 0;
  list.replaceChildren();
  if (items.length === 0) {
    list.innerHTML = `<div class="empty-state"><h3>暂无错词</h3><p>评价为“误判”时会自动加入，也可以从全部词库手动添加。</p></div>`;
    return;
  }
  items.forEach(item => list.append(createWordRow(item, "wrong")));
}

function startWrongReview() {
  const ids = wrongItems().map(recordId);
  if (ids.length === 0) return;
  wrongSession = { queue: ids, completed: 0 };
  renderWrongPractice();
  $("#wrong-review-host").scrollIntoView({ behavior: "smooth", block: "start" });
}

function startSingleWrongReview(id) {
  wrongSession = { queue: [id], completed: 0 };
  renderWrongPractice();
  $("#wrong-review-host").scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderWrongPractice() {
  const host = $("#wrong-review-host");
  if (!wrongSession) {
    host.replaceChildren();
    return;
  }
  if (wrongSession.queue.length === 0) {
    host.innerHTML = `<div class="empty-state"><h3>本轮错词复习完成</h3><p>复习记录已保存。</p></div>`;
    return;
  }
  const id = wrongSession.queue[0];
  const total = wrongSession.completed + wrongSession.queue.length;
  renderStudyCard(host, itemById.get(id), `${wrongSession.completed + 1} / ${total}`, rating => {
    const wasStudied = recordFor(id).studied;
    applyRating(id, rating);
    wrongSession.queue.shift();
    wrongSession.completed += 1;
    if (!wasStudied && rating === "again") wrongSession.queue.push(id);
    renderStats();
    renderWrongList();
    renderLibrary();
    renderWrongPractice();
  });
}

function populateGroups() {
  const select = $("#group-filter");
  const groups = [];
  words.forEach(item => {
    if (!groups.some(group => group.id === String(item.组ID))) {
      groups.push({ id: String(item.组ID), type: item.类型, number: item.组别, name: item.组名 });
    }
  });
  groups.forEach(group => {
    const option = document.createElement("option");
    option.value = group.id;
    option.textContent = `${group.type} · 第${group.number}组 · ${group.name}`;
    select.append(option);
  });
}

function renderLibrary() {
  if (words.length === 0) return;
  const query = $("#word-search").value.trim();
  const type = $("#type-filter").value;
  const group = $("#group-filter").value;
  const items = words.filter(item =>
    (!query || item.词语.includes(query)) &&
    (!type || item.类型 === type) &&
    (!group || String(item.组ID) === group)
  );
  $("#library-count").textContent = `显示 ${items.length} / ${words.length}`;
  const list = $("#library-list");
  list.replaceChildren();
  if (items.length === 0) {
    list.innerHTML = `<div class="empty-state"><h3>没有匹配结果</h3><p>请更换关键词、类型或组别。</p></div>`;
    return;
  }
  items.forEach(item => list.append(createWordRow(item, "library")));
}

function createWordRow(item, mode) {
  const id = recordId(item);
  const record = recordFor(id);
  const row = document.createElement("article");
  row.className = "word-row";
  const main = document.createElement("div");
  main.className = "word-main";
  const headingLine = document.createElement("div");
  headingLine.className = "word-heading-line";
  const title = document.createElement("h3");
  title.textContent = `${item.序号}. ${item.词语}`;
  headingLine.append(title, makeTypeBadge(item.类型));
  const meta = document.createElement("p");
  meta.className = "word-meta";
  meta.textContent = `${item.册别} · 第${item.组别}组 · ${item.组名} · ${item.小分类}`;
  const idLine = document.createElement("p");
  idLine.className = "record-id-line";
  idLine.textContent = `记录ID：${id}`;
  const statuses = document.createElement("div");
  statuses.className = "statuses";
  statuses.append(statusBadge(record.studied ? "已学过" : "未学习", record.studied ? "status-learned" : ""));
  if (record.inWrongBook) statuses.append(statusBadge("错词", "status-wrong"));
  main.append(headingLine, meta, idLine, statuses);

  const actions = document.createElement("div");
  actions.className = "row-actions";
  if (mode === "wrong") {
    actions.append(actionButton("复习", () => startSingleWrongReview(id), "button-primary"));
    actions.append(actionButton("移出", () => toggleWrong(id)));
  } else {
    actions.append(actionButton("查看详情", () => openDetail(item)));
    actions.append(actionButton(record.inWrongBook ? "移出错词" : "加入错词", () => toggleWrong(id)));
  }
  row.append(main, actions);
  return row;
}

function statusBadge(text, className) {
  const span = document.createElement("span");
  span.className = `status ${className}`.trim();
  span.textContent = text;
  return span;
}

function actionButton(text, handler, className = "") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `button ${className}`.trim();
  button.textContent = text;
  button.addEventListener("click", handler);
  return button;
}

function openDetail(item) {
  detailItem = item;
  $("#detail-meta").textContent = `${item.类型} · ${item.册别} · 第${item.组别}组 · ${item.组名}`;
  $("#detail-title").textContent = item.词语;
  const content = $("#detail-content");
  content.replaceChildren();
  const plain = String(item.说人话 || "").trim();
  if (plain) content.append(detailBlock("说人话", plain, "plain-meaning-block"));
  content.append(originalDefinitionBlock(item.原书释义, !plain));
  content.append(detailBlock("记录ID", item.记录ID));
  content.append(detailBlock("小分类", item.小分类));
  if (String(item.使用提示 || "").trim()) content.append(detailBlock("使用提示", item.使用提示));
  const examples = [item.例句1, item.例句2, item.例句3].filter(value => String(value || "").trim()).slice(0, 3);
  if (examples.length) {
    const block = document.createElement("div");
    block.className = "detail-block";
    const heading = document.createElement("h3");
    heading.textContent = "例句";
    const list = document.createElement("ol");
    list.className = "study-examples";
    examples.forEach((example, index) => {
      const li = document.createElement("li");
      const text = document.createElement("span");
      text.textContent = example;
      const readExample = document.createElement("button");
      readExample.type = "button";
      readExample.className = "example-speech-button";
      readExample.textContent = "🔊";
      readExample.setAttribute("aria-label", `朗读第${index + 1}条例句`);
      readExample.title = `朗读第${index + 1}条例句`;
      readExample.addEventListener("click", () => speakText(example));
      li.append(text, readExample);
      list.append(li);
    });
    block.append(heading, list);
    content.append(block);
  }
  content.append(detailBlock("来源页码", `${item.册别}资料第 ${item.资料页码} 页（PDF 第 ${item.PDF页序} 页）`));
  syncCardSpeechUi(content);
  updateDetailWrongButton();
  $("#detail-dialog").showModal();
}

function originalDefinitionBlock(text, expanded) {
  const block = document.createElement("details");
  block.className = "original-definition";
  block.open = expanded;
  const summary = document.createElement("summary");
  summary.textContent = "四海原书释义";
  const paragraph = document.createElement("p");
  paragraph.textContent = text;
  block.append(summary, paragraph);
  return block;
}

function detailBlock(title, text, className = "") {
  const block = document.createElement("div");
  block.className = `detail-block ${className}`.trim();
  const heading = document.createElement("h3");
  heading.textContent = title;
  const paragraph = document.createElement("p");
  paragraph.textContent = text;
  block.append(heading, paragraph);
  return block;
}

function updateDetailWrongButton() {
  if (detailItem) updateWrongButton($("#detail-wrong-toggle"), recordId(detailItem));
}

function exportProgress() {
  const payload = { version: 1, keyField: "记录ID", progress };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `四海1000词学习进度_${localDate()}.json`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
  showToast("学习进度已导出");
}

async function importProgress(event) {
  const input = event.currentTarget;
  const file = input.files && input.files[0];
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    const source = parsed && parsed.progress;
    if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error("缺少 progress 对象");
    const imported = {};
    Object.entries(source).forEach(([id, value]) => {
      if (itemById.has(id)) imported[id] = sanitizeRecord(value);
    });
    if (Object.keys(source).length > 0 && Object.keys(imported).length === 0) {
      throw new Error("没有匹配的记录ID，旧版名称键进度不能导入");
    }
    progress = imported;
    saveProgress();
    localStorage.removeItem(DAILY_KEY);
    dailyPlan = { date: "", ids: [] };
    ensureDailyPlan();
    rebuildTodaySessions();
    wrongSession = null;
    renderAll();
    showToast(`已导入 ${Object.keys(imported).length} 条学习进度`);
  } catch (error) {
    console.warn("导入失败", error);
    alert(`导入失败：${error.message}`);
  } finally {
    input.value = "";
  }
}

function resetProgress() {
  if (!confirm("第一次确认：要删除本机全部学习进度吗？此操作无法撤销。")) return;
  if (!confirm("第二次确认：确定重置全部进度？")) return;
  localStorage.removeItem(PROGRESS_KEY);
  localStorage.removeItem(DAILY_KEY);
  progress = {};
  dailyPlan = { date: "", ids: [] };
  wrongSession = null;
  ensureDailyPlan();
  rebuildTodaySessions();
  renderAll();
  showToast("全部学习进度已重置");
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 2200);
}

