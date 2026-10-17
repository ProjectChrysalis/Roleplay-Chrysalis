import { llmFailReason } from "../passes.js";
import { LANG_CODES, TRANSLATE_CHUNKS, chunkForTranslate } from "../translate.js";

// translate: LLM or provider-proxy translation (message menu, composer).
// Providers: google (unofficial endpoint,
// keyless), lingva (keyless), deepl (keyed — the key is app-level config
// by design in data/settings.json ui.translation.deeplKey: user-entered
// app config, not an engine credential, so app backups include it), or
// llm (any engine model). HTTP providers ride the two-phase host.net
// contract exactly like the URL importer.
export function translateRoute(c) {
  const { req, host, head, ok, err, readJson, body } = c;
    if (head === "translate" && req.method === "POST") {
      const b = body();
      const ui = (readJson("settings.json", {}).ui || {});
      const tcfg = ui.translation || {};
      const provider = ["llm", "google", "lingva", "deepl"].includes(b.provider) ? b.provider : (tcfg.provider || "llm");
      const target = String(b.target || tcfg.targetLanguage || "English");
      const text = String(b.text || "");
      if (!text.trim()) return err(400, "nothing to translate");

      if (provider === "llm") {
        const reply = host.llm.results.translation;
        if (!reply) {
                    const model = readJson("settings.json", {}).model;
          host.llm.request("translation", {
            messages: [{ role: "user", content: "Translate the following text to " + target + ". Output ONLY the translation, no commentary.\n\n" + text }],
            ...(model ? { model } : {}),
          });
          // no chat meta here — nothing to stash (this used to pass an
          // undefined `meta` and throw, killing every provider on pass A)
          return { __llmPending: true };
        }
        if (reply.model === "error") return err(503, llmFailReason(reply));
        return ok({ text: String(reply.text || "").trim() });
      }

      if (!host.net) return err(503, "network permission not granted");
      const code = LANG_CODES[target.toLowerCase()];
      if (!code) return err(400, "no language code for \"" + target + "\" — pick a listed language or use the llm provider");
      const deeplKey = provider === "deepl" ? String(b.deeplKey || tcfg.deeplKey || "") : "";
      if (provider === "deepl" && !deeplKey) return err(400, "DeepL needs an API key (Tools → Translation)");
      // every chunk rides as its own keyed request; all keys land together on
      // the next pass and stitch back in order
      const chunks = chunkForTranslate(text, TRANSLATE_CHUNKS[provider] || 4000);
      const keyOf = (i) => "tr:" + i;
      const extract = (j) => {
        if (provider === "google" && Array.isArray(j) && Array.isArray(j[0])) return j[0].map((x) => (Array.isArray(x) ? x[0] : "")).join("");
        if (provider === "lingva" && j && typeof j.translation === "string") return j.translation;
        if (provider === "deepl" && j && j.translations && j.translations[0] && typeof j.translations[0].text === "string") return j.translations[0].text;
        return "";
      };
      if (chunks.some((_, i) => host.net.results[keyOf(i)] == null)) {
        chunks.forEach((c, i) => {
          if (provider === "google") {
            host.net.request(keyOf(i), {
              url: "https://translate.google.com/translate_a/single?client=gtx&sl=auto&tl=" + code + "&dt=t&q=" + encodeURIComponent(c),
              json: true, maxBytes: 1024 * 1024,
            });
          } else if (provider === "lingva") {
            host.net.request(keyOf(i), {
              url: "https://lingva.ml/api/v1/auto/" + code + "/" + encodeURIComponent(c),
              json: true, maxBytes: 1024 * 1024,
            });
          } else {
            const base = /:pro$/i.test(deeplKey) ? "https://api.deepl.com" : "https://api-free.deepl.com";
            host.net.request(keyOf(i), {
              url: base + "/v2/translate",
              method: "POST",
              headers: { authorization: "DeepL-Auth-Key " + deeplKey.replace(/:pro$/i, "") },
              body: { text: [c], target_lang: code.split("-")[0].toUpperCase() },
              json: true, maxBytes: 1024 * 1024,
            });
          }
        });
        return { __llmPending: true };
      }
      let out = "";
      for (let i = 0; i < chunks.length; i++) {
        const r = host.net.results[keyOf(i)];
        if (!r.ok) return err(502, "translation provider failed (" + r.status + " " + (r.statusText || "") + ")");
        out += extract(r.json);
      }
      if (!out.trim()) return err(502, "translation provider returned no text");
      return ok({ text: out.trim() });
    }
}
