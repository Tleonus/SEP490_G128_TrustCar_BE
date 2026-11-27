import { setupAuthHarness } from './helpers/fakeAuthModels.js';
const h = await setupAuthHarness();
test('boots', () => { expect(h.app).toBeTruthy(); });
