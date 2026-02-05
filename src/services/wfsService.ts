import { addCorridors } from './corridorService';

const BASE_WFS_URL =
  'https://portal.csdi.gov.hk/server/services/common/td_rcd_1638949160594_2844/MapServer/WFSServer';

const FILTER_XML =
  "<Filter><Intersects><PropertyName>SHAPE</PropertyName>" +
  "<gml:Envelope srsName='EPSG:4326'>" +
  "<gml:lowerCorner>22.15 113.81</gml:lowerCorner>" +
  "<gml:upperCorner>22.62 114.45</gml:upperCorner>" +
  '</gml:Envelope></Intersects></Filter>';

const COMMON_QUERY =
  'service=wfs&request=GetFeature&typenames=CENTERLINE' +
  '&outputFormat=geojson&srsName=EPSG:4326' +
  '&filter=' + encodeURIComponent(FILTER_XML);

const PAGE_SIZE = 1000;
const MAX_PAGES = 5;

export async function fetchAdditionalCorridorsFromWFS(): Promise<void> {
  let startIndex = 0;
  let totalAdded = 0;
  let pageCount = 0;

  while (true) {
    if (pageCount >= MAX_PAGES) {
      console.log('Reached MAX_PAGES for WFS, stopping.');
      break;
    }
    pageCount++;

    const url =
      `${BASE_WFS_URL}?${COMMON_QUERY}` +
      `&maxFeatures=${PAGE_SIZE}&startIndex=${startIndex}`;

    console.log(`Fetching WFS page: startIndex=${startIndex} ...`);  // <-- add

    let res: Response;
    try {
      res = await fetch(url);
    } catch (err) {
      console.error('Error calling WFS:', err);
      throw err;
    }

    if (!res.ok) {
      throw new Error(`WFS request failed: ${res.status} ${res.statusText}`);
    }

    const geojson = (await res.json()) as any;
    const features: any[] = Array.isArray(geojson.features)
      ? geojson.features
      : [];

    if (features.length === 0) {
      console.log('No more features from WFS, stopping paging.');
      break;
    }

    const batch: { [routeId: number]: any } = {};
    let pageAdded = 0;

    for (const feature of features) {
      const props = feature.properties || {};
      const routeId = props.ROUTE_ID;
      if (!routeId) continue;

      batch[routeId] = {
        type: feature.type,
        properties: { ...props, IS_FROM_WFS: true },
        geometry: feature.geometry,
      };
      pageAdded++;
    }

    addCorridors(batch);
    totalAdded += pageAdded;

    console.log(                                         // <-- add
      `✓ Page startIndex=${startIndex}: added ${pageAdded} routes ` +
      `(total so far: ${totalAdded})`
    );

    startIndex += PAGE_SIZE;
  }

  console.log(`✓ Finished WFS fetch, total added routes: ${totalAdded}`); // <-- add
}
