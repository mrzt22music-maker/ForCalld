// ==========================================================
// ForCall — регистрация
// ==========================================================

const cfg = window.FORCALL_CONFIG;
const supabase = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);

const avatarInput = document.getElementById('avatarInput');
const avatarPreview = document.getElementById('avatarPreview');
const nicknameInput = document.getElementById('nickname');
let avatarFile = null;

avatarInput.addEventListener('change', () => {
  const file = avatarInput.files[0];
  if (!file) return;
  avatarFile = file;
  const reader = new FileReader();
  reader.onload = (e) => {
    avatarPreview.innerHTML = `<img src="${e.target.result}" alt="avatar">`;
  };
  reader.readAsDataURL(file);
});

nicknameInput.addEventListener('input', () => {
  if (!avatarFile && nicknameInput.value.trim()) {
    avatarPreview.textContent = nicknameInput.value.trim()[0].toUpperCase();
  }
});

document.getElementById('goCallBtn').addEventListener('click', () => {
  window.location.href = 'call.html';
});

document.getElementById('registerForm').addEventListener('submit', async (e) => {
  e.preventDefault();

  if (cfg.SUPABASE_URL.includes('ВАШ-ПРОЕКТ')) {
    alert('Сначала впиши свои ключи Supabase в config.js — инструкция в README.md');
    return;
  }

  const submitBtn = document.getElementById('submitBtn');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Создаём...';

  const username = document.getElementById('username').value.trim().toLowerCase();
  const nickname = document.getElementById('nickname').value.trim();
  const language = document.getElementById('language').value.trim();

  try {
    // проверяем, что юзернейм свободен
    const { data: existing } = await supabase
      .from('users')
      .select('username')
      .eq('username', username)
      .maybeSingle();

    if (existing) {
      alert('Этот юзернейм уже занят, придумай другой');
      submitBtn.disabled = false;
      submitBtn.textContent = 'Создать точку связи';
      return;
    }

    // загружаем аватарку, если есть
    let avatarUrl = null;
    if (avatarFile) {
      const ext = avatarFile.name.split('.').pop();
      const path = `${username}.${ext}`;
      const { error: uploadError } = await supabase.storage
        .from('avatars')
        .upload(path, avatarFile, { upsert: true });

      if (!uploadError) {
        const { data: pub } = supabase.storage.from('avatars').getPublicUrl(path);
        avatarUrl = pub.publicUrl;
      }
    }

    // создаём запись пользователя
    const { error: insertError } = await supabase.from('users').insert({
      username,
      nickname,
      avatar_url: avatarUrl,
      language,
    });

    if (insertError) throw insertError;

    // запоминаем "кто я" локально на этом устройстве
    localStorage.setItem('forcall_me', JSON.stringify({ username, nickname, avatarUrl, language }));

    window.location.href = 'call.html';

  } catch (err) {
    console.error(err);
    alert('Что-то пошло не так: ' + (err.message || err));
    submitBtn.disabled = false;
    submitBtn.textContent = 'Создать точку связи';
  }
});
