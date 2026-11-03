(() => {
  const languages = ['fr','en','es','ru','de','ar','zh','it','ro','hu'];
  const rows = window.RECBLUE_TRANSLATION_ROWS;
  const dictionary = new Map(rows.map(row => [row[0], row]));
  const originals = new WeakMap();
  const attributes = new WeakMap();
  const select = document.getElementById('language-select');
  let language = 'fr';
  const templates = {
    close: ['Fermer','Close','Cerrar','Закрыть','Schließen','إغلاق','关闭','Chiudi','Închide','Bezárás'],
    photo: ['Agrandir la photo {n} du DormRoom','Enlarge DormRoom photo {n}','Ampliar foto {n} de DormRoom','Увеличить фото {n} DormRoom','DormRoom-Foto {n} vergrößern','تكبير صورة DormRoom {n}','放大 DormRoom 照片 {n}','Ingrandisci foto {n} di DormRoom','Mărește fotografia {n} DormRoom','DormRoom {n}. fotó nagyítása'],
    memory: ['DormRoom — souvenir {n}','DormRoom — memory {n}','DormRoom — recuerdo {n}','DormRoom — воспоминание {n}','DormRoom — Erinnerung {n}','DormRoom — ذكرى {n}','DormRoom — 回忆 {n}','DormRoom — ricordo {n}','DormRoom — amintire {n}','DormRoom — emlék {n}'],
    rights: ['Droits de {name}','Permissions for {name}','Permisos de {name}','Права {name}','Rechte für {name}','صلاحيات {name}','{name} 的权限','Permessi di {name}','Drepturi pentru {name}','{name} jogosultságai']
  };
  function translate(text) {
    const index = languages.indexOf(language);
    const value = String(text).trim();
    if (dictionary.has(value)) return dictionary.get(value)[index];
    if (/^Fermer (?:le |la |les |l’)/.test(value)) return templates.close[index];
    let match = value.match(/^Agrandir la photo (\d+) du DormRoom$/);
    if (match) return templates.photo[index].replace('{n}', match[1]);
    match = value.match(/^DormRoom — souvenir (\d+)$/);
    if (match) return templates.memory[index].replace('{n}', match[1]);
    match = value.match(/^Droits de (.+)$/);
    if (match) return templates.rights[index].replace('{name}', match[1]);
    return value;
  }
  window.recblueTranslate = translate;
  function excluded(element) {
    return !element || element.closest('script,style,code,#language-select option,input,textarea,[data-no-translate]');
  }
  function updateText(node) {
    if (excluded(node.parentElement) || !node.nodeValue.trim()) return;
    const current = node.nodeValue;
    let stored = originals.get(node);
    if (!stored || (current !== stored.rendered && current !== stored.source)) stored = { source:current };
    const leading = stored.source.match(/^\s*/)[0], trailing = stored.source.match(/\s*$/)[0];
    stored.rendered = leading + translate(stored.source) + trailing;
    originals.set(node, stored);
    if (current !== stored.rendered) node.nodeValue = stored.rendered;
  }
  function updateAttributes(element) {
    if (excluded(element)) return;
    const stored = attributes.get(element) || {};
    for (const key of ['aria-label','placeholder','title','alt']) {
      if (!element.hasAttribute(key)) continue;
      const value = element.getAttribute(key);
      if (!stored[key] || (value !== stored[key].rendered && value !== stored[key].source)) stored[key] = { source:value };
      stored[key].rendered = translate(stored[key].source);
      if (value !== stored[key].rendered) element.setAttribute(key, stored[key].rendered);
    }
    attributes.set(element, stored);
  }
  function translateTree(root) {
    if (root.nodeType === Node.TEXT_NODE) { updateText(root); return; }
    if (root.nodeType !== Node.ELEMENT_NODE || excluded(root)) return;
    updateAttributes(root);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      if (walker.currentNode.nodeType === Node.TEXT_NODE) updateText(walker.currentNode);
      else updateAttributes(walker.currentNode);
    }
  }
  window.recblueApplyLanguage = () => {
    language = languages.includes(select.value) ? select.value : 'fr';
    document.documentElement.lang = language;
    document.documentElement.dir = language === 'ar' ? 'rtl' : 'ltr';
    translateTree(document.documentElement);
    document.dispatchEvent(new CustomEvent('recblue:language', { detail:language }));
  };
  const observer = new MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'characterData') updateText(record.target);
      else if (record.type === 'attributes') updateAttributes(record.target);
      else record.addedNodes.forEach(translateTree);
    }
  });
  observer.observe(document.documentElement, { subtree:true, childList:true, characterData:true, attributes:true, attributeFilter:['aria-label','placeholder','title','alt'] });
})();
