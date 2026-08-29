import assert from 'node:assert/strict';
import test from 'node:test';

import {
  addComment,
  addPhoto,
  addTimelineItem,
  addUser,
  createInitialState,
  getCurrentUser,
  toggleReaction,
} from '../src/store.js';

test('adding the first user signs them in', () => {
  const state = addUser(createInitialState(), {
    id: 'user-1',
    name: '  Casey  ',
    firstName: ' Casey ',
    lastName: ' Jones ',
    username: ' caseyj ',
    salt: 'salt',
    passwordHash: 'hash',
  }, { autoSignIn: true });

  assert.equal(state.currentUserId, 'user-1');
  assert.equal(getCurrentUser(state).name, 'Casey');
  assert.equal(getCurrentUser(state).firstName, 'Casey');
  assert.equal(getCurrentUser(state).lastName, 'Jones');
  assert.equal(getCurrentUser(state).username, 'caseyj');
  assert.equal(getCurrentUser(state).isAdmin, true);
});

test('adding another user does not change the current user by default', () => {
  const signedInState = addUser(createInitialState(), {
    id: 'user-1',
    name: 'Casey',
    salt: 'salt',
    passwordHash: 'hash',
  }, { autoSignIn: true });

  const state = addUser(signedInState, {
    id: 'user-2',
    name: 'Jordan',
    salt: 'salt',
    passwordHash: 'hash',
  });

  assert.equal(state.currentUserId, 'user-1');
  assert.equal(state.users[1].isAdmin, false);
});

test('photos support comments and one reaction per user', () => {
  let state = addPhoto(createInitialState(), {
    id: 'photo-1',
    title: ' Reunion ',
    description: ' Backyard picnic ',
    imageData: 'data:image/png;base64,abc',
    uploadedBy: 'Casey',
    createdAt: '2026-08-29T00:00:00.000Z',
  });

  state = addComment(state, 'photo-1', {
    id: 'comment-1',
    author: 'Jordan',
    text: ' Looks fun! ',
    createdAt: '2026-08-29T01:00:00.000Z',
  });
  state = toggleReaction(state, 'photo-1', '❤️', 'user-1');
  state = toggleReaction(state, 'photo-1', '❤️', 'user-1');
  state = toggleReaction(state, 'photo-1', '❤️', 'user-2');

  assert.equal(state.photos[0].title, 'Reunion');
  assert.equal(state.photos[0].comments[0].text, 'Looks fun!');
  assert.deepEqual(state.photos[0].reactions['❤️'], ['user-2']);
});

test('timeline items are sorted newest first', () => {
  let state = createInitialState();

  state = addTimelineItem(state, 'events', {
    id: 'event-1',
    title: 'Spring picnic',
    date: '2026-04-10',
    description: 'Park shelter',
    createdBy: 'Casey',
  });
  state = addTimelineItem(state, 'events', {
    id: 'event-2',
    title: 'Winter dinner',
    date: '2026-12-20',
    description: "Grandma's house",
    createdBy: 'Casey',
  });

  assert.deepEqual(
    state.events.map((event) => event.id),
    ['event-2', 'event-1'],
  );
});
