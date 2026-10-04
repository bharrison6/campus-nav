// Small campus payloads shared by the connectivity check's tests (connectivity.unit.mjs) and the route engine's
// (access-classes.unit.mjs), so both are asserted on the same data and must agree (Codex review v5, finding 2).

const F1 = { id: 'f1', buildingId: 'B', level: 1, label: 'First Floor', metersPerPixel: 1 };

/**
 * room a -> waypoint m -> room b, every node main; `emergencyEdge` marks the a-m hallway edge emergency (the nodes
 * stay main), `emergencyNode` marks m emergency. Either way the check and findPath both say: no route from a to b.
 */
export function emergencyEdgeCampus({ emergencyEdge = true, emergencyNode = false } = {}) {
  return {
    buildings: [],
    floors: [F1],
    rooms: [
      { id: 'A', floorId: 'f1', searchable: true },
      { id: 'B1', floorId: 'f1', searchable: true },
    ],
    navNodes: [
      { id: 'a', floorId: 'f1', type: 'room', roomId: 'A', x: 0, y: 0 },
      { id: 'm', floorId: 'f1', type: 'waypoint', x: 5, y: 0, access: emergencyNode ? 'emergency' : 'main' },
      { id: 'b', floorId: 'f1', type: 'room', roomId: 'B1', x: 10, y: 0 },
    ],
    navEdges: [
      { id: 'a-m', fromNodeId: 'a', toNodeId: 'm', distance: 5, ...(emergencyEdge ? { access: 'emergency' } : {}) },
      { id: 'm-b', fromNodeId: 'm', toNodeId: 'b', distance: 5 },
    ],
    config: [],
  };
}
