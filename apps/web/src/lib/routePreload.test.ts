import { describe, expect, it } from 'vitest';
import { pageKeyForPath, pathFromHash } from './routePreload.ts';

describe('route preload mapping', () => {
  it('parses the router path from location.hash', () => {
    expect(pathFromHash('')).toBe('/');
    expect(pathFromHash('#/')).toBe('/');
    expect(pathFromHash('#/videos?mode=upload')).toBe('/videos');
    expect(pathFromHash('#/creators/niconico:user%2F1')).toBe('/creators/niconico:user%2F1');
  });
  it('maps every route to its page chunk (unknown paths -> 404)', () => {
    expect(pageKeyForPath('/')).toBe('dashboard');
    expect(pageKeyForPath('/videos')).toBe('videos');
    expect(pageKeyForPath('/videos/')).toBe('videos');
    expect(pageKeyForPath('/creators')).toBe('creators');
    expect(pageKeyForPath('/creators/channel-a')).toBe('creatorDetail');
    expect(pageKeyForPath('/creators/niconico:user/143537376')).toBe('creatorDetail');
    expect(pageKeyForPath('/api-docs')).toBe('apiDocs');
    expect(pageKeyForPath('/does-not-exist')).toBe('notFound');
  });
});
