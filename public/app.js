(() => {
  const chat = document.getElementById("chat");
  const empty = document.getElementById("empty");
  const form = document.getElementById("form");
  const input = document.getElementById("q");
  const sendBtn = document.getElementById("send");
  const newChatBtn = document.getElementById("newChat");

  let messages = []; // {role, content} — kept in memory only, never stored
  let busy = false;

  const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");

  // Minimal, safe markdown: paragraphs, bullet lists, numbered lists, **bold**.
  function render(text) {
    const out = [];
    let list = null;
    const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      let m;
      if (!line) { close(); continue; }
      if ((m = line.match(/^[-*•]\s+(.*)/))) {
        if (list !== "ul") { close(); out.push("<ul>"); list = "ul"; }
        out.push(`<li>${inline(m[1])}</li>`);
      } else if ((m = line.match(/^(?:\d+|[٠-٩]+)[.)]\s+(.*)/))) {
        if (list !== "ol") { close(); out.push("<ol>"); list = "ol"; }
        out.push(`<li>${inline(m[1])}</li>`);
      } else {
        close();
        out.push(`<p>${inline(line.replace(/^#+\s*/, ""))}</p>`);
      }
    }
    close();
    return out.join("");
  }

  const scrollDown = () => { chat.scrollTop = chat.scrollHeight; };

  function addUser(text) {
    const el = document.createElement("div");
    el.className = "msg user";
    el.innerHTML = `<div class="body" dir="auto"></div>`;
    el.firstChild.textContent = text;
    chat.appendChild(el);
    scrollDown();
  }

  function addTyping() {
    const el = document.createElement("div");
    el.className = "msg bot";
    el.innerHTML = `<div class="body"><span class="typing" role="status" aria-label="بيدوّر في المصادر"><i></i><i></i><i></i></span></div>`;
    chat.appendChild(el);
    scrollDown();
    return el;
  }

  function fillBot(el, data) {
    el.className = "msg bot" + (data.abstained ? " muted" : "");
    el.innerHTML = `<div class="body" dir="auto">${render(data.answer)}</div>`;
    const tools = document.createElement("div");
    tools.className = "tools";
    const copy = document.createElement("button");
    copy.type = "button";
    copy.textContent = "نسخ الإجابة";
    copy.onclick = async () => {
      try { await navigator.clipboard.writeText(data.answer); copy.textContent = "اتنسخت"; }
      catch { copy.textContent = "مقدرتش أنسخ"; }
      setTimeout(() => (copy.textContent = "نسخ الإجابة"), 1600);
    };
    tools.appendChild(copy);
    if (data.sources && data.sources.length) {
      const det = document.createElement("details");
      det.className = "sources";
      const sum = document.createElement("summary");
      sum.textContent = `المصادر (${data.sources.length})`;
      const ul = document.createElement("ul");
      for (const s of data.sources) {
        const li = document.createElement("li");
        li.textContent = s.label;
        if (s.section) { const sm = document.createElement("small"); sm.textContent = s.section; li.appendChild(sm); }
        ul.appendChild(li);
      }
      det.append(sum, ul);
      tools.appendChild(det);
    }
    el.appendChild(tools);
    scrollDown();
  }

  function fillError(el, message, retry) {
    el.className = "msg bot error";
    el.innerHTML = `<div class="body" dir="auto"></div>`;
    el.firstChild.textContent = message;
    const tools = document.createElement("div");
    tools.className = "tools";
    const b = document.createElement("button");
    b.type = "button"; b.className = "retry"; b.textContent = "حاول تاني";
    b.onclick = () => { el.remove(); retry(); };
    tools.appendChild(b);
    el.appendChild(tools);
    scrollDown();
  }

  function setBusy(v) {
    busy = v;
    sendBtn.disabled = v || !input.value.trim();
  }

  async function ask(question) {
    const history = messages.slice(-5);
    const typing = addTyping();
    setBusy(true);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, history }),
      });
      let data = {};
      try { data = await res.json(); } catch { /* non-JSON error */ }
      if (!res.ok || !data.answer) throw new Error(data.error || "حصلت مشكلة. جرّب تاني.");
      messages.push({ role: "user", content: question }, { role: "assistant", content: data.answer });
      fillBot(typing, data);
    } catch (e) {
      fillError(typing, e.message || "مفيش اتصال بالإنترنت.", () => ask(question));
    } finally {
      setBusy(false);
      input.focus();
    }
  }

  function submit() {
    const q = input.value.trim();
    if (!q || busy) return;
    empty.hidden = true;
    newChatBtn.hidden = false;
    addUser(q);
    input.value = "";
    autosize();
    ask(q);
  }

  function autosize() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 160) + "px";
    sendBtn.disabled = busy || !input.value.trim();
  }

  form.addEventListener("submit", (e) => { e.preventDefault(); submit(); });
  input.addEventListener("input", autosize);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
  });
  newChatBtn.addEventListener("click", () => {
    if (busy) return;
    messages = [];
    chat.querySelectorAll(".msg").forEach((n) => n.remove());
    empty.hidden = false;
    newChatBtn.hidden = true;
    input.focus();
  });
  input.focus();
})();
