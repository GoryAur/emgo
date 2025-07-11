#!/bin/bash

BASE_DIR="/media/movies"

echo "🔍 Escaneando symlinks y carpetas reales en: $BASE_DIR"
echo

find "$BASE_DIR" -mindepth 1 -maxdepth 1 \( -type l -o -type d \) -name "*:*" | while read -r path; do
    name=$(basename "$path")
    dir=$(dirname "$path")

    # Reemplazo estilo Radarr: ": " → " - ", ":" → " -"
    new_name="${name//: / - }"
    new_name="${new_name//:/ -}"
    new_path="$dir/$new_name"

    echo "🔁 Detectado con ':' → $name"

    if [[ "$path" == "$new_path" ]]; then
        echo "   ❕ Ya está limpio, sin cambios."
        continue
    fi

    if [[ -e "$new_path" ]]; then
        echo "   ⚠️  No se puede renombrar, ya existe: $new_name"
        continue
    fi

    mv "$path" "$new_path"
    echo "   ✅ Renombrado → $new_name"
    echo
done

echo "✅ Completado."
