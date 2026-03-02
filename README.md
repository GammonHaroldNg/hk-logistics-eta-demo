# hk-logistics-eta-demo

HK Logistics ETA Demo with traffic integration, concrete delivery simulation, and ClickUp list sync.

---

## How "Start from ClickUp" works

1. **User** selects a ClickUp list in the side panel and clicks **Start from ClickUp**.
2. **Backend** starts a delivery session (path geometries, config), then fetches all tasks from that list via the ClickUp API.
3. **Mapping** Each task is mapped to a trip using custom fields:
   - **Concrete Plant** → which route to use (Gammon TM Plant → site or HKC Tsing Yi Plant → site).
   - **Actual Departure** → when the truck left the plant (used as simulation start time if present).
   - **Actual Arrival** → when the truck arrived at site (for “arrived” timeline and progress).
   - **Time Period** (e.g. 06:00–07:00) → planned arrival window; 4 trips in that period = planned 4 arrivals for that hour.
   - **Status** → which trips to show and animate:
     - **On the way** → show truck marker and animate along the route.
     - **Not started** → do not show a marker.
     - **Rejected** / **Not Used** / **Arrived** → trip is finished (no animation); only **Arrived** counts for actual progress, using **Actual Arrival Time** for which time period it belongs to.
4. **Simulation** Only trips with status “on the way” (and a start time: actual or planned) get a truck on the map. Each truck moves along its route (by path from Concrete Plant) using estimated speed and duration (ETA). Progress bar and delay warnings use **Arrived** trips and their **Actual Arrival Time** vs planned time periods.
5. **Planned vs actual** Planned amount for the day comes from summing planned trips per **Time Period**. Actual amount comes from trips with status **Arrived** and their **Actual Arrival Time** assigned to the correct time period.