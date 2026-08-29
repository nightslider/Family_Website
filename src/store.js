const STORAGE_KEY = 'familyWebsiteState';
const defaultState = {
  users: [],
  currentUserId: null,
  photos: [],
  events: [],
  milestones: [],
};

export function createInitialState() {
  return {
    ...defaultState,
    users: [],
    photos: [],
    events: [],
    milestones: [],
  };
}

export function loadState(storage = globalThis.localStorage) {
  if (!storage) {
    return createInitialState();
  }

  try {
    const stored = storage.getItem(STORAGE_KEY);
    if (!stored) {
      return createInitialState();
    }

    return normalizeState(JSON.parse(stored));
  } catch {
    return createInitialState();
  }
}

export function saveState(state, storage = globalThis.localStorage) {
  if (!storage) {
    return state;
  }

  storage.setItem(STORAGE_KEY, JSON.stringify(normalizeState(state)));
  return state;
}

export function normalizeState(state) {
  return {
    ...createInitialState(),
    ...(state && typeof state === 'object' ? state : {}),
    users: Array.isArray(state?.users) ? state.users : [],
    photos: Array.isArray(state?.photos) ? state.photos : [],
    events: Array.isArray(state?.events) ? state.events : [],
    milestones: Array.isArray(state?.milestones) ? state.milestones : [],
  };
}

export function createId(prefix = 'item') {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${random}`;
}

export function addUser(state, user, options = {}) {
  const normalized = normalizeState(state);
  const nextUser = {
    id: user.id ?? createId('user'),
    name: user.name.trim(),
    passwordHash: user.passwordHash,
    salt: user.salt,
  };

  return {
    ...normalized,
    currentUserId: options.autoSignIn ? nextUser.id : normalized.currentUserId,
    users: [...normalized.users, nextUser],
  };
}

export function addPhoto(state, photo) {
  const normalized = normalizeState(state);
  const nextPhoto = {
    id: photo.id ?? createId('photo'),
    title: photo.title.trim(),
    description: photo.description.trim(),
    imageData: photo.imageData,
    uploadedBy: photo.uploadedBy,
    createdAt: photo.createdAt ?? new Date().toISOString(),
    comments: [],
    reactions: {},
  };

  return {
    ...normalized,
    photos: [nextPhoto, ...normalized.photos],
  };
}

export function addComment(state, photoId, comment) {
  const normalized = normalizeState(state);

  return {
    ...normalized,
    photos: normalized.photos.map((photo) => {
      if (photo.id !== photoId) {
        return photo;
      }

      return {
        ...photo,
        comments: [
          ...(Array.isArray(photo.comments) ? photo.comments : []),
          {
            id: comment.id ?? createId('comment'),
            author: comment.author,
            text: comment.text.trim(),
            createdAt: comment.createdAt ?? new Date().toISOString(),
          },
        ],
      };
    }),
  };
}

export function toggleReaction(state, photoId, emoji, userId) {
  const normalized = normalizeState(state);

  return {
    ...normalized,
    photos: normalized.photos.map((photo) => {
      if (photo.id !== photoId) {
        return photo;
      }

      const reactions = { ...(photo.reactions ?? {}) };
      const users = new Set(reactions[emoji] ?? []);

      if (users.has(userId)) {
        users.delete(userId);
      } else {
        users.add(userId);
      }

      reactions[emoji] = [...users];

      return {
        ...photo,
        reactions,
      };
    }),
  };
}

export function addTimelineItem(state, collectionName, item) {
  const normalized = normalizeState(state);
  const collection = Array.isArray(normalized[collectionName]) ? normalized[collectionName] : [];
  const nextItem = {
    id: item.id ?? createId(collectionName.slice(0, -1) || 'timeline'),
    title: item.title.trim(),
    date: item.date,
    description: item.description.trim(),
    createdBy: item.createdBy,
    createdAt: item.createdAt ?? new Date().toISOString(),
  };

  return {
    ...normalized,
    [collectionName]: [nextItem, ...collection].sort((a, b) => (a.date === b.date ? 0 : b.date > a.date ? 1 : -1)),
  };
}

export function getCurrentUser(state) {
  const normalized = normalizeState(state);
  return normalized.users.find((user) => user.id === normalized.currentUserId) ?? null;
}
