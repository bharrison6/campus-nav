import json
import svgwrite

# "AI Parsed" Data - This represents the output of a Vision Language Model
# analyzing the floor plan and extracting semantic room objects.
# Note: Coordinates are normalized (0-1000) for the main building block.

AI_EXTRACTED_ROOMS = [
    # --- WEST WING (Offices) ---
    {"number": "141", "label": "", "type": "Office", "rect": [50, 50, 50, 50]},
    {"number": "142", "label": "", "type": "Office", "rect": [50, 100, 50, 40]},
    {"number": "144", "label": "", "type": "Office", "rect": [50, 140, 50, 40]},
    {"number": "145", "label": "", "type": "Office", "rect": [50, 180, 50, 40]},
    {"number": "147", "label": "", "type": "Office", "rect": [50, 220, 50, 50]},
    {"number": "148", "label": "", "type": "Office", "rect": [50, 270, 50, 40]},
    {"number": "149", "label": "", "type": "Office", "rect": [50, 310, 50, 40]},
    {"number": "150", "label": "", "type": "Office", "rect": [50, 350, 50, 40]},
    {"number": "161", "label": "", "type": "Office", "rect": [50, 390, 50, 50]},
    
    # --- INNER WEST (Utility/Small Labs) ---
    {"number": "140A", "label": "Mech Room", "type": "Utility", "rect": [100, 50, 100, 70]},
    {"number": "143", "label": "Equipment", "type": "Storage", "rect": [100, 120, 100, 80]},
    {"number": "146", "label": "OSH Training", "type": "Classroom", "rect": [100, 200, 100, 80]},
    {"number": "152", "label": "W", "type": "Restroom", "rect": [100, 280, 40, 60]},
    {"number": "153", "label": "Changing", "type": "Restroom", "rect": [140, 280, 40, 60]},
    {"number": "154", "label": "M", "type": "Restroom", "rect": [180, 280, 20, 60]},
    {"number": "156", "label": "", "type": "Office", "rect": [100, 390, 50, 50]},
    {"number": "155", "label": "Classroom", "type": "Classroom", "rect": [150, 360, 100, 80]},

    # --- CENTER BLOCK (Large Labs) ---
    {"number": "121", "label": "Materials and Process Lab", "type": "Lab", "rect": [200, 50, 150, 150]},
    {"number": "123", "label": "Interior Design Studio", "type": "Lab", "rect": [200, 200, 150, 100]},
    {"number": "120", "label": "Mech Room", "type": "Utility", "rect": [200, 300, 75, 60]},
    {"number": "127", "label": "Design Lab", "type": "Lab", "rect": [275, 300, 75, 60]},

    # --- EAST WING ---
    {"number": "122", "label": "Phone Room", "type": "Utility", "rect": [350, 150, 50, 50]},
    {"number": "124", "label": "Architectural Design", "type": "Lab", "rect": [350, 200, 150, 100]},
    {"number": "125", "label": "Graphics Lab", "type": "Lab", "rect": [350, 300, 150, 100]},
    {"number": "134", "label": "Machine Tool", "type": "Lab", "rect": [350, 400, 150, 100]},

    # --- SOUTH STRIP ---
    {"number": "130", "label": "Lounge", "type": "Common", "rect": [250, 440, 100, 60]},
    {"number": "131", "label": "OSH Lab", "type": "Lab", "rect": [250, 500, 100, 80]},
    {"number": "133", "label": "Industrial Hygiene", "type": "Lab", "rect": [350, 500, 100, 80]},
    {"number": "135", "label": "Fire Safety", "type": "Lab", "rect": [450, 500, 80, 80]},
    
    # --- ANGLED WING (Approximated) ---
    # Represented as rotated rectangles
    {"number": "101", "label": "Incubation", "type": "Lab", "rect": [350, -50, 80, 100], "rotate": 30},
    {"number": "102", "label": "Incubation", "type": "Lab", "rect": [430, -50, 80, 100], "rotate": 30},
    {"number": "104", "label": "Strength", "type": "Lab", "rect": [510, -50, 80, 100], "rotate": 30},
]

def generate_svg(filename):
    dwg = svgwrite.Drawing(filename, size=(800, 800))
    # Add white background
    dwg.add(dwg.rect(insert=(0, 0), size=(800, 800), fill="white"))
    
    # Define styles
    styles = {
        "Office": {"fill": "#e0f7fa", "stroke": "#006064"},
        "Lab": {"fill": "#f3e5f5", "stroke": "#880e4f"},
        "Utility": {"fill": "#eceff1", "stroke": "#455a64"},
        "Restroom": {"fill": "#e1f5fe", "stroke": "#0277bd"},
        "Classroom": {"fill": "#fff3e0", "stroke": "#e65100"},
        "Storage": {"fill": "#efebe9", "stroke": "#3e2723"},
        "Common": {"fill": "#f1f8e9", "stroke": "#33691e"}
    }

    # Main Group with transform to center it
    main_g = dwg.g(transform="translate(100, 100)")

    for room in AI_EXTRACTED_ROOMS:
        x, y, w, h = room["rect"]
        rot = room.get("rotate", 0)
        
        style = styles.get(room["type"], {"fill": "#ffffff", "stroke": "#000000"})
        
        # Create group for room to handle rotation
        rg = dwg.g()
        if rot:
            rg['transform'] = f"rotate({-rot}, {x}, {y+h})"
            
        # Draw Room Polygon
        rg.add(dwg.rect(insert=(x, y), size=(w, h), 
                        fill=style["fill"], stroke=style["stroke"], stroke_width=2))
        
        # Draw Label (Number)
        rg.add(dwg.text(room["number"], insert=(x + w/2, y + h/2),
                        font_size=14, font_family="Arial", font_weight="bold",
                        text_anchor="middle", fill="black", alignment_baseline="middle"))
        
        # Draw Label (Name) - simplified
        if room["label"] and w > 60:
            words = room["label"].split()
            if len(words) > 0:
                rg.add(dwg.text(words[0], insert=(x + w/2, y + h/2 + 15),
                                font_size=10, font_family="Arial",
                                text_anchor="middle", fill="#555", alignment_baseline="middle"))

        main_g.add(rg)

    dwg.add(main_g)
    dwg.save()
    print(f"Generated {filename}")

if __name__ == "__main__":
    generate_svg("ai_parsed_floor1.svg")
