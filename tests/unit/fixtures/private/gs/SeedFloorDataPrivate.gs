/**
 * A synthetic private seed for the tests (the shape scripts/floorplan-pipeline/stages/emit-gas.mjs PRIVATE_SEED
 * writes to the private location): one made-up hidden floor, floor-it-9 "Test Loft", with two rooms, three nodes, two
 * edges and a cross-floor edge from the real IT second-floor stair it-stair-1 (it-2-n0064). Not campus data: the real
 * hidden floors are never in the repository.
 */
function getPrivateFloorsSeed() {
  return [
    ["floor-it-9","bld-it",9,"Test Loft","FP_floor_it_9",400,200,0.0254,false]
  ];
}
function getPrivateRoomsSeed() {
  return [
    ["room-it-9-0901","floor-it-9","0901","901 Test Loft","office","[[200,20],[380,20],[380,180],[200,180]]",290,100,true,""],
    ["room-it-9-0952","floor-it-9","0952","952","stair","[[20,20],[120,20],[120,180],[20,180]]",70,100,true,""]
  ];
}
function getPrivateNavNodesSeed() {
  return [
    ["it-9-n0001","floor-it-9",290,100,"room","room-it-9-0901","",""],
    ["it-9-n0002","floor-it-9",70,100,"stair","room-it-9-0952","it-stair-1",""],
    ["it-9-n0003","floor-it-9",160,100,"waypoint","","","main"]
  ];
}
function getPrivateNavEdgesSeed() {
  return [
    ["it-9-e0001","it-9-n0002","it-9-n0003",2.3,false,true],
    ["it-9-e0002","it-9-n0003","it-9-n0001",3.3,false,true],
    ["it-x901","it-2-n0064","it-9-n0002",10,true,false]
  ];
}
