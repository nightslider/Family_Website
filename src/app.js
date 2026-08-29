import {
  normalizeState,
} from './store.js';

const reactions = ['❤️', '😂', '🎉', '🙏', '😍'];
let state = normalizeState();
let currentUser = null;

const app = document.querySelector('#app');

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
    },
    credentials: 'same-origin',
    ...options,
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload.error ?? 'Something went wrong.');
  }

  return payload;
}

async function refreshData() {
  const data = await api('/api/data');
  state = normalizeState(data);
}

async function loadSession() {
  try {
    const session = await api('/api/me');
    currentUser = session.user;
    await refreshData();
  } catch {
    currentUser = null;
    state = normalizeState();
  }

  render();
}

function el(tag, options = {}, children = []) {
  const node = document.createElement(tag);
  const { className, text, attrs, on } = options;

  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  if (attrs) {
    Object.entries(attrs).forEach(([name, value]) => {
      if (value !== undefined && value !== null) {
        node.setAttribute(name, value);
      }
    });
  }
  if (on) {
    Object.entries(on).forEach(([eventName, handler]) => node.addEventListener(eventName, handler));
  }

  children.filter(Boolean).forEach((child) => node.append(child));
  return node;
}

function clearApp() {
  app.replaceChildren();
}

function render() {
  clearApp();

  if (!currentUser) {
    renderLogin();
    return;
  }

  renderDashboard(currentUser);
}

function renderLogin() {
  const form = el('form', { className: 'card auth-card' });
  const message = el('p', { className: 'form-message', attrs: { role: 'status' } });
  const nameInput = el('input', {
    attrs: {
      id: 'name',
      autocomplete: 'username',
      placeholder: 'Your name',
      required: '',
    },
  });
  const passwordInput = el('input', {
    attrs: {
      id: 'password',
      type: 'password',
      autocomplete: 'current-password',
      placeholder: 'Family password',
      required: '',
    },
  });

  form.append(
    el('h1', { text: 'Family Website' }),
    el('p', {
      text: 'Sign in to view photos, reactions, comments, events, and milestones.',
    }),
    el('label', { attrs: { for: 'name' }, text: 'Name' }),
    nameInput,
    el('label', { attrs: { for: 'password' }, text: 'Password' }),
    passwordInput,
    el('button', { text: 'Log in', attrs: { type: 'submit' } }),
    message,
  );

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = nameInput.value.trim();
    const password = passwordInput.value;

    if (!name || !password) {
      message.textContent = 'Please enter your name and password.';
      return;
    }

    try {
      const session = await api('/api/login', {
        method: 'POST',
        body: JSON.stringify({ name, password }),
      });
      currentUser = session.user;
      await refreshData();
      render();
    } catch (error) {
      message.textContent = error.message;
    }
  });

  app.append(el('main', { className: 'auth-shell' }, [form]));
}

function renderDashboard(user) {
  const main = el('main', { className: 'page-shell' });
  main.append(
    el('header', { className: 'hero' }, [
      el('div', {}, [
        el('p', { className: 'eyebrow', text: 'Private family space' }),
        el('h1', { text: 'Share photos, moments, and memories' }),
        el('p', { text: `Welcome, ${user.name}. Only signed-in family members can see this page.` }),
      ]),
      el('button', {
        className: 'secondary',
        text: 'Log out',
        on: {
          click: async () => {
            await api('/api/logout', { method: 'POST' });
            currentUser = null;
            state = normalizeState();
            render();
          },
        },
      }),
    ]),
    el('section', { className: 'grid two-column' }, [
      renderUserForm(),
      renderPhotoForm(),
      renderTimelineForm('events', 'Add family event', 'Event title'),
      renderTimelineForm('milestones', 'Add milestone', 'Milestone title'),
    ]),
    renderGallery(user),
    renderTimeline('Upcoming and recent events', state.events),
    renderTimeline('Family milestones', state.milestones),
  );

  app.append(main);
}

function renderUserForm() {
  const form = el('form', { className: 'card' });
  const nameInput = el('input', { attrs: { placeholder: 'Family member name', autocomplete: 'off', required: '' } });
  const passwordInput = el('input', {
    attrs: { type: 'password', placeholder: 'Temporary password', autocomplete: 'new-password', required: '' },
  });
  const message = el('p', { className: 'form-message', attrs: { role: 'status' } });

  form.append(
    el('h2', { text: 'Add family login' }),
    nameInput,
    passwordInput,
    el('button', { text: 'Create login', attrs: { type: 'submit' } }),
    message,
  );

  form.addEventListener('submit', async (event) => {
    event.preventDefault();

    try {
      await api('/api/users', {
        method: 'POST',
        body: JSON.stringify({ name: nameInput.value, password: passwordInput.value }),
      });
      nameInput.value = '';
      passwordInput.value = '';
      await refreshData();
      message.textContent = 'Family login created.';
    } catch (error) {
      message.textContent = error.message;
    }
  });

  return form;
}

function renderPhotoForm() {
  const form = el('form', { className: 'card' });
  const titleInput = el('input', { attrs: { placeholder: 'Photo title', required: '' } });
  const descriptionInput = el('textarea', { attrs: { placeholder: 'Tell the story behind this photo' } });
  const fileInput = el('input', { attrs: { type: 'file', accept: 'image/*', required: '' } });
  const message = el('p', { className: 'form-message', attrs: { role: 'status' } });
  const submitButton = el('button', { text: 'Share photo', attrs: { type: 'submit' } });

  form.append(
    el('h2', { text: 'Upload a photo' }),
    titleInput,
    descriptionInput,
    fileInput,
    submitButton,
    message,
  );

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    submitButton.disabled = true;
    const [file] = fileInput.files;

    if (!file) {
      message.textContent = 'Choose a photo to upload.';
      submitButton.disabled = false;
      return;
    }

    const imageData = await readFile(file);
    try {
      await api('/api/photos', {
        method: 'POST',
        body: JSON.stringify({
          title: titleInput.value,
          description: descriptionInput.value,
          imageData,
        }),
      });
      await refreshData();
      render();
    } catch (error) {
      message.textContent = error.message;
      submitButton.disabled = false;
    }
  });

  return form;
}

function renderTimelineForm(collectionName, heading, titlePlaceholder) {
  const form = el('form', { className: 'card' });
  const titleInput = el('input', { attrs: { placeholder: titlePlaceholder, required: '' } });
  const dateInput = el('input', { attrs: { type: 'date', required: '' } });
  const descriptionInput = el('textarea', { attrs: { placeholder: 'Details' } });
  const message = el('p', { className: 'form-message', attrs: { role: 'status' } });
  const submitButton = el('button', { text: 'Save', attrs: { type: 'submit' } });

  form.append(
    el('h2', { text: heading }),
    titleInput,
    dateInput,
    descriptionInput,
    submitButton,
    message,
  );

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    submitButton.disabled = true;

    try {
      await api(`/api/${collectionName}`, {
        method: 'POST',
        body: JSON.stringify({
          title: titleInput.value,
          date: dateInput.value,
          description: descriptionInput.value,
        }),
      });
      await refreshData();
      titleInput.value = '';
      dateInput.value = '';
      descriptionInput.value = '';
      render();
    } catch (error) {
      message.textContent = error.message;
      submitButton.disabled = false;
    }
  });

  return form;
}

function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(reader.result));
    reader.addEventListener('error', () => reject(reader.error));
    reader.readAsDataURL(file);
  });
}

function renderGallery(currentUser) {
  const cards = state.photos.map((photo) => renderPhotoCard(photo, currentUser));
  return el('section', { className: 'section' }, [
    el('h2', { text: 'Photo gallery' }),
    cards.length
      ? el('div', { className: 'gallery' }, cards)
      : el('p', { className: 'empty-state', text: 'No photos yet. Upload the first family memory.' }),
  ]);
}

function renderPhotoCard(photo, currentUser) {
  const commentInput = el('input', { attrs: { placeholder: 'Write a comment', required: '' } });
  const commentMessage = el('p', { className: 'form-message compact', attrs: { role: 'status' } });
  const submitButton = el('button', { text: 'Comment', attrs: { type: 'submit' } });
  const commentForm = el('form', { className: 'comment-form' }, [
    commentInput,
    submitButton,
  ]);

  commentForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    submitButton.disabled = true;

    try {
      await api(`/api/photos/${encodeURIComponent(photo.id)}/comments`, {
        method: 'POST',
        body: JSON.stringify({ text: commentInput.value }),
      });
      await refreshData();
      commentInput.value = '';
      render();
    } catch (error) {
      commentMessage.textContent = error.message;
      submitButton.disabled = false;
    }
  });

  return el('article', { className: 'photo-card' }, [
    el('img', { attrs: { src: photo.imageData, alt: photo.title } }),
    el('div', { className: 'photo-body' }, [
      el('h3', { text: photo.title }),
      el('p', { text: photo.description || 'No description added.' }),
      el('p', { className: 'meta', text: `Uploaded by ${photo.uploadedBy} on ${formatDate(photo.createdAt)}` }),
      el('div', { className: 'reaction-row' }, reactions.map((emoji) => renderReactionButton(photo, emoji, currentUser))),
      renderComments(photo),
      commentForm,
      commentMessage,
    ]),
  ]);
}

function renderReactionButton(photo, emoji, currentUser) {
  const count = photo.reactions?.[emoji]?.length ?? 0;
  const active = photo.reactions?.[emoji]?.includes(currentUser.id);

  return el('button', {
    className: active ? 'reaction active' : 'reaction',
    text: `${emoji} ${count}`,
    attrs: { type: 'button', 'aria-label': `React with ${emoji}` },
    on: {
      click: () =>
        api(`/api/photos/${encodeURIComponent(photo.id)}/reactions`, {
          method: 'POST',
          body: JSON.stringify({ emoji }),
        })
          .then(refreshData)
          .then(render)
          .catch(() => {}),
    },
  });
}

function renderComments(photo) {
  const comments = Array.isArray(photo.comments) ? photo.comments : [];

  if (!comments.length) {
    return el('p', { className: 'empty-state compact', text: 'No comments yet.' });
  }

  return el(
    'ul',
    { className: 'comments' },
    comments.map((comment) =>
      el('li', {}, [
        el('strong', { text: comment.author }),
        document.createTextNode(` ${comment.text}`),
        el('span', { className: 'meta', text: formatDate(comment.createdAt) }),
      ]),
    ),
  );
}

function renderTimeline(heading, items) {
  return el('section', { className: 'section' }, [
    el('h2', { text: heading }),
    items.length
      ? el(
          'div',
          { className: 'timeline' },
          items.map((item) =>
            el('article', { className: 'timeline-item' }, [
              el('time', { text: formatDate(item.date), attrs: { datetime: item.date } }),
              el('h3', { text: item.title }),
              el('p', { text: item.description || 'No details added.' }),
              el('p', { className: 'meta', text: `Added by ${item.createdBy}` }),
            ]),
          ),
        )
      : el('p', { className: 'empty-state', text: `No ${heading.toLowerCase()} added yet.` }),
  ]);
}

function formatDate(value) {
  if (!value) {
    return '';
  }

  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(value));
}

loadSession();
