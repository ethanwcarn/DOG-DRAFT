/** GET /api/breeds - the static breed catalog and group list. */
import { BREEDS, GROUPS } from '../lib/breeds.js';
import { POINTS, PICKS_PER_GROUP, UNDERDOG_MAX_PICKERS } from '../lib/scoring.js';
import { route, requireMethod, sendJson } from '../lib/http.js';

export default route(async (req, res) => {
  requireMethod(req, 'GET');
  sendJson(
    res,
    200,
    {
      groups: GROUPS,
      breeds: BREEDS.map(({ id, name, group, wiki, blurb }) => ({ id, name, group, wiki, blurb })),
      rules: { points: POINTS, picksPerGroup: PICKS_PER_GROUP, underdogMaxPickers: UNDERDOG_MAX_PICKERS },
    },
    { 'Cache-Control': 'public, max-age=300, s-maxage=300' },
  );
});
