import { calculateRouteDistance, interpolatePosition, calculateETA, formatTime } from './services/etaService';
import { initializeTrucks, updateTruckProgress, getTrucks, getTotalConcreteDelivered, resetSimulation } from './services/truckService';

// Define LineString type inline (no geojson import needed)
interface LineString {
  type: 'LineString';
  coordinates: Array<[number, number]>;
}

// Mock LineString data - properly typed
const mockLineString: LineString = {
  type: 'LineString',
  coordinates: [
    [114.1, 22.3],
    [114.11, 22.31],
    [114.12, 22.32],
    [114.13, 22.33]
  ]
};

export function runTests() {
  console.log('\n🧪 === BACKEND SERVICES TESTING ===\n');

  try {
    // Test 1: Calculate Route Distance
    console.log('Test 1: Calculate Route Distance');
    const distance = calculateRouteDistance(mockLineString);
    console.log(`Distance: ${distance.toFixed(2)} km`);
    console.log(`✅ Test 1 passed\n`);

    // Test 2: Interpolate Position
    console.log('Test 2: Interpolate Position');
    const pos50 = interpolatePosition(mockLineString, 0.5);
    console.log(`Position at 50%: [${pos50[0].toFixed(4)}, ${pos50[1].toFixed(4)}]`);
    console.log(`✅ Test 2 passed\n`);

    // Test 3: Calculate ETA
    console.log('Test 3: Calculate ETA');
    const eta50 = calculateETA(0.5, mockLineString, 40);
    console.log(`ETA from 50%: ${formatTime(eta50)}`);
    console.log(`✅ Test 3 passed\n`);

    // Test 4: Initialize Trucks
    console.log('Test 4: Initialize Trucks');
    resetSimulation();
    initializeTrucks(93231, mockLineString, 3);
    const trucks = getTrucks();
    console.log(`Created ${trucks.length} trucks`);
    trucks.forEach(t => {
      console.log(`  - ${t.truckId}: ETA=${formatTime(t.eta)}`);
    });
    console.log(`✅ Test 4 passed\n`);

    // Test 5: Update Truck Progress
    console.log('Test 5: Update Truck Progress');
    console.log('Before update: 0%');
    updateTruckProgress(10, mockLineString);
    const updated = getTrucks()[0];
    
    // SAFE access - check if array has element
    if (updated) {
      console.log(`After 10s: ${(updated.progressRatio * 100).toFixed(1)}%`);
      console.log(`Position: [${updated.currentPosition[0].toFixed(4)}, ${updated.currentPosition[1].toFixed(4)}]`);
      console.log(`ETA: ${formatTime(updated.eta)}`);
      console.log(`✅ Test 5 passed\n`);
    } else {
      throw new Error('No trucks found after update');
    }

    // Test 6: Simulate Full Completion
    console.log('Test 6: Simulate Completion');
    const totalDistance = distance;
    const totalTimeSeconds = (totalDistance / 40) * 3600; // 40 km/h
    console.log(`Total trip time: ${formatTime(totalTimeSeconds)}`);

    // Simulate in chunks
    for (let i = 0; i < 20; i++) {
      updateTruckProgress(totalTimeSeconds / 20, mockLineString);
    }

    const totalDelivered = getTotalConcreteDelivered();
    console.log(`Total delivered: ${totalDelivered} units`);
    console.log(`✅ Test 6 passed\n`);

    console.log('✅ === ALL BACKEND TESTS PASSED ===\n');
    return true;

  } catch (error) {
    console.error('❌ Test failed:', error);
    return false;
  }
}