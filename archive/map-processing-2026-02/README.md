# Retired: raster floor-plan pipeline (2026-02)

These Python/OpenCV scripts were the first attempt at digitizing the IT and EP floor plans: they split,
cleaned and OCR'd raster images of the event-day PDF maps (`Maps/`, not in git) to detect rooms and
reproduce them as SVG. They are superseded by the DWG pipeline in `scripts/floorplan-pipeline/`, which
reads the university's AutoCAD drawings (`data/dwg/`) and produces exact room polygons, room numbers and
the navigation graph, so nothing here is run or maintained. The scripts are kept for reference only;
their inputs and outputs live outside the repository and may no longer exist.
