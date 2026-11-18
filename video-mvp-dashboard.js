"use strict";

{
  const capability = fetch("/api/videos/render/status", { cache: "no-store" })
    .then(response => response.ok ? response.json() : null)
    .then(status => status?.mvpEnabled === true)
    .catch(() => false);

  async function request(url, options) {
    const response = await fetch(url, { cache: "no-store", ...options });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || result.message || `HTTP ${response.status}`);
    return result;
  }

  function element(tag, text) {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    return node;
  }

  function field(parent, name, attributes) {
    const label = element("label", name + " ");
    const input = Object.assign(element("input"), attributes);
    label.append(input);
    parent.append(label);
    return input;
  }

  function button(parent, label, type = "button") {
    const control = element("button", label);
    control.type = type;
    parent.append(control);
    return control;
  }

  const errors = {
    INVALID_MEDIA_TYPE: "Choisissez un PNG, un JPEG ou un MP3 selon le champ.",
    INVALID_MEDIA_CONTENT: "Le fichier ne peut pas être décodé.",
    LEGACY_PROJECT_STORAGE: "Créez un nouveau projet pour ajouter des médias en montage manuel.",
    PROJECT_STORAGE_CHANGED: "Le mode de stockage a changé. Relancez le rendu.",
    PROJECT_SCENE_LIMIT: "Un projet accepte 30 scènes et 600 secondes au maximum.",
    NARRATION_ALREADY_SET: "Une narration est déjà enregistrée pour ce projet.",
    NO_PROJECT_SCENES: "Ajoutez au moins une scène illustrée.",
    SCENE_IMAGE_NOT_READY: "Chaque scène doit disposer d’une image prête.",
    PAYLOAD_TOO_LARGE: "Le fichier dépasse 20 Mio."
  };

  window.attachVideoMvp = async function attachVideoMvp(item, projectId) {
    if (!await capability) return;
    const url = `/api/videos/${encodeURIComponent(projectId)}/mvp`;
    const panel = element("details");
    panel.className = "video-mvp";
    panel.style.marginTop = "12px";
    panel.append(element("summary", "Montage manuel et MP4"));

    const status = element("p");
    status.setAttribute("role", "status");
    const list = element("ol");
    const narrationStatus = element("p");
    panel.append(list, narrationStatus, status);

    const scene = element("form");
    const title = field(scene, "Titre de la scène", { required: true, maxLength: 120 });
    const seconds = field(scene, "Durée (secondes)", { type: "number", min: 1, max: 600, step: 1, value: 5, required: true });
    const picture = field(scene, "Image", { type: "file", accept: "image/png,image/jpeg", required: true });
    const addScene = button(scene, "Ajouter la scène", "submit");

    const audio = element("form");
    const narration = field(audio, "Narration MP3 (facultative)", { type: "file", accept: "audio/mpeg,.mp3", required: true });
    const addNarration = button(audio, "Ajouter la narration", "submit");
    panel.append(scene, audio);
    const render = button(panel, "Générer le MP4");
    const result = element("div");
    panel.append(result);
    item.append(panel);

    let hasNarration = false;
    let ready = false;
    let manualAllowed = false;
    let busy = false;
    function refresh() {
      addScene.disabled = busy || !manualAllowed;
      addNarration.disabled = narration.disabled = busy || hasNarration || !manualAllowed;
      render.disabled = busy || !ready;
    }
    async function load() {
      const project = await request(url);
      hasNarration = project.narration;
      manualAllowed = project.manualAllowed;
      scene.hidden = audio.hidden = !manualAllowed;
      ready = project.scenes.length > 0 &&
        project.scenes.every(s => s.has_image && Number(s.duration_seconds) > 0);
      list.replaceChildren(...project.scenes.map(s => element("li",
        `${s.scene_number}. ${s.title} · ${s.duration_seconds ?? "durée manquante"} s` +
        (s.has_image ? "" : " · image manquante"))));
      narrationStatus.textContent = !manualAllowed
        ? "Les scènes historiques restent disponibles pour le rendu. Pour ajouter vos fichiers, créez un nouveau projet."
        : hasNarration ? "Narration enregistrée." : "Aucune narration enregistrée.";
    }
    async function run(action, message) {
      if (busy) return;
      busy = true;
      status.textContent = message;
      refresh();
      try {
        await action();
        status.textContent = "Terminé.";
      } catch (error) {
        status.textContent = errors[error.message] || `Opération impossible (${error.message}).`;
      } finally {
        busy = false;
        refresh();
      }
    }
    function upload(endpoint, file, mime) {
      return request(url + endpoint, { method: "POST", headers: { "Content-Type": mime }, body: file });
    }

    panel.addEventListener("toggle", () => {
      if (panel.open) run(load, "Chargement du montage…");
    });
    scene.addEventListener("submit", event => {
      event.preventDefault();
      run(async () => {
        const params = new URLSearchParams({ title: title.value, seconds: seconds.value });
        await upload("/scenes?" + params, picture.files[0], picture.files[0].type);
        scene.reset();
        await load();
      }, "Enregistrement de la scène…");
    });
    audio.addEventListener("submit", event => {
      event.preventDefault();
      run(async () => {
        await upload("/narration", narration.files[0], "audio/mpeg");
        audio.reset();
        await load();
      }, "Enregistrement de la narration…");
    });
    render.addEventListener("click", () => run(async () => {
      result.replaceChildren();
      const video = await request("/api/videos/render", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId })
      });
      if (!/^\/api\/videos\/render\/download\/[a-f0-9-]{36}$/.test(video.downloadUrl || "")) {
        throw new Error("INVALID_VIDEO_LINK");
      }
      const player = Object.assign(element("video"), { controls: true, preload: "metadata", src: video.downloadUrl + "?preview=1" });
      player.style.display = "block";
      player.style.maxWidth = "100%";
      player.style.maxHeight = "480px";
      const link = Object.assign(element("a", "Télécharger le MP4"), { href: video.downloadUrl });
      result.append(player, link);
    }, "Rendu vidéo en cours…"));
    refresh();
  };
}
