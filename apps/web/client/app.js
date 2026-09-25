const $ = id => document.getElementById(id);
let session = null, sending = false, starting = false;
function status(text, error = false) { $('chat-status').textContent = text; $('chat-status').classList.toggle('error', error); }
async function api(path, data) {
  const response = await fetch(path, { method: data === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
    headers: data === undefined ? {} : { 'content-type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(65_000) });
  const payload = await response.json();
  if (!response.ok) { const error = new Error(payload.error || 'The service is unavailable. Please try again.'); error.status = response.status; throw error; }
  return payload;
}
function renderAccess() {
  $('send-message').disabled = sending || starting || !session?.agentConfigured;
  $('chat-input').disabled = sending || starting;
  $('new-chat').disabled = sending || starting;
  $('new-chat').textContent = session ? 'New chat' : 'Retry connection';
  for (const button of $('chat-suggestions').querySelectorAll('button')) button.disabled = sending || starting;
}
function addMessage(role, content) {
  const item = document.createElement('div'); item.className = `message ${role}`;
  const label = document.createElement('span'); label.className = 'speaker'; label.textContent = role === 'user' ? 'You' : 'Afterhour';
  const body = document.createElement('p'); body.textContent = content; item.append(label, body); $('messages').append(item);
  $('messages').scrollTop = $('messages').scrollHeight;
}
function showMessages(messages) {
  $('messages').replaceChildren();
  if (!messages.length) { const empty = document.createElement('p'); empty.className = 'message empty';
    empty.textContent = 'What would you like to know about Afterhours?'; $('messages').append(empty); }
  else for (const message of messages) addMessage(message.role, message.content);
  $('chat-suggestions').hidden = messages.length > 0;
}
function connectionStatus() {
  status(session?.agentConfigured ? '' : 'The agent connection is being set up. Live replies will be available here once it is connected.');
}
async function startSession() {
  if (starting) return;
  starting = true; renderAccess(); status('Opening your conversation…');
  try {
    session = await api('/api/chat/session', {});
    showMessages(session.messages); connectionStatus();
  } catch (error) { session = null; status(error.message, true); }
  finally { starting = false; renderAccess(); }
}
$('new-chat').addEventListener('click', async () => {
  if (!session) { await startSession(); return; }
  if (sending || starting) return;
  starting = true; renderAccess();
  try {
    await api('/api/chat/reset', {}); showMessages([]); $('chat-input').value = '';
    if (session.agentConfigured) status('New conversation started.'); else connectionStatus();
  } catch (error) {
    if (error.status === 401) session = null;
    status(error.message, true);
  } finally { starting = false; renderAccess(); }
});
for (const button of $('chat-suggestions').querySelectorAll('button')) button.addEventListener('click', () => {
  $('chat-input').value = button.textContent; $('chat-input').focus();
});
$('chat-input').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('chat-form').requestSubmit(); } });
$('chat-form').addEventListener('submit', async event => {
  event.preventDefault(); const text = $('chat-input').value.trim();
  if (!text || !session?.agentConfigured || sending || starting) return;
  sending = true; renderAccess(); status('Afterhour is thinking…');
  try {
    const result = await api('/api/chat', { message: text });
    $('messages').querySelector('.empty')?.remove(); addMessage('user', text); addMessage('assistant', result.answer);
    $('chat-input').value = ''; $('chat-suggestions').hidden = true; status('');
  } catch (error) {
    if (error.status === 401) {
      session = null; await startSession();
      if (session?.agentConfigured) status('A new session is ready. Send your message again.');
    } else status(error.message, true);
  } finally { sending = false; renderAccess(); $('chat-input').focus(); }
});
showMessages([]);
void startSession();
