(() => {
  const players = [...document.querySelectorAll('audio')];
  players.forEach(audio => {
    audio.addEventListener('play', () => players.forEach(other => { if (other !== audio) other.pause(); }));
    audio.addEventListener('error', () => { audio.closest('.player').querySelector('.audio-error').hidden = false; });
  });
  function selectEdition(card, variant) {
    card.querySelectorAll('.edition-panel').forEach(panel => {
      panel.hidden = panel.dataset.variant !== variant;
      if (panel.hidden) panel.querySelector('audio').pause();
    });
    card.querySelectorAll('[data-edition]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.edition === variant)));
  }
  document.querySelectorAll('[data-edition]:not(:disabled)').forEach(button => button.addEventListener('click', () => selectEdition(button.closest('.episode'), button.dataset.edition)));
  function revealHash() {
    const panel = document.getElementById(location.hash.slice(1));
    if (!panel?.classList.contains('edition-panel')) return;
    selectEdition(panel.closest('.episode'), panel.dataset.variant);
    panel.closest('.episode').scrollIntoView();
  }
  window.addEventListener('hashchange', revealHash);
  revealHash();
  document.getElementById('month-jump')?.addEventListener('change', event => {
    const card = document.getElementById(event.target.value);
    if (card) { location.hash = card.id; card.querySelector('h3').setAttribute('tabindex', '-1'); card.querySelector('h3').focus({ preventScroll: true }); }
  });
  // One pending seek per player; repeated clicks before metadata do not stack listeners.
  const pending = new WeakMap();
  function seek(audio, time) {
    const apply = () => { audio.currentTime = Math.max(0, Math.min(time, Number.isFinite(audio.duration) ? audio.duration : time)); };
    const prior = pending.get(audio);
    if (prior) audio.removeEventListener('loadedmetadata', prior);
    if (audio.readyState >= 1) { pending.delete(audio); apply(); }
    else { pending.set(audio, apply); audio.addEventListener('loadedmetadata', apply, { once: true }); audio.load(); }
  }
  document.querySelectorAll('button[data-player]').forEach(button => button.addEventListener('click', () => {
    const audio = document.getElementById(button.dataset.player);
    seek(audio, button.dataset.seek !== undefined ? Number(button.dataset.seek) : audio.currentTime + Number(button.dataset.skip));
  }));
  document.querySelectorAll('select[data-player]').forEach(select => select.addEventListener('change', () => {
    document.getElementById(select.dataset.player).playbackRate = Number(select.value);
  }));
})();
