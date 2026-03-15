#!/bin/bash

USE_HASH=false
USE_SIZE=false
DIRS=()

for arg in "$@"; do
    if [[ "$arg" == "--hash" ]]; then
        USE_HASH=true
    elif [[ "$arg" == "--size" ]]; then
        USE_SIZE=true
    else
        DIRS+=("$arg")
    fi
done

if [[ ${#DIRS[@]} -eq 0 || ${#DIRS[@]} -gt 2 ]]; then
    echo "Usage: $(basename "$0") [--hash] [--size] dir1 [dir2]" >&2
    exit 1
fi

declare -A file_groups

while IFS= read -r filepath; do
    lower_basename=$(basename "$filepath" | tr '[:upper:]' '[:lower:]')
    if [[ -z "${file_groups[$lower_basename]}" ]]; then
        file_groups[$lower_basename]="$filepath"
    else
        file_groups[$lower_basename]+=$'\n'"$filepath"
    fi
done < <(find "${DIRS[@]}" -type f | sort)

confirmed=()
name_only=()

for key in $(echo "${!file_groups[@]}" | tr ' ' '\n' | sort); do
    mapfile -t paths <<< "${file_groups[$key]}"

    if [[ ${#paths[@]} -lt 2 ]]; then
        continue
    fi

    label=""

    if $USE_SIZE; then
        first_size=""
        all_same=true

        for filepath in "${paths[@]}"; do
            size=$(stat --printf="%s" "$filepath" 2>/dev/null)
            if [[ -z "$first_size" ]]; then
                first_size="$size"
            elif [[ "$size" != "$first_size" ]]; then
                all_same=false
                break
            fi
        done

        if ! $all_same; then
            label="name match only"
        fi
    fi

    if [[ -z "$label" ]] && $USE_HASH; then
        first_hash=""
        all_same=true
        has_unreadable=false

        for filepath in "${paths[@]}"; do
            if [[ ! -r "$filepath" ]]; then
                has_unreadable=true
                continue
            fi
            hash=$(md5sum "$filepath" 2>/dev/null | awk '{print $1}')
            if [[ -z "$first_hash" ]]; then
                first_hash="$hash"
            elif [[ "$hash" != "$first_hash" ]]; then
                all_same=false
            fi
        done

        if $has_unreadable; then
            label="name match only (unreadable)"
        elif ! $all_same; then
            label="name match only"
        fi
    fi

    # Build the formatted block for this group
    block=""
    for filepath in "${paths[@]}"; do
        line=$(stat --printf="%n   %y %s\n" "$filepath" 2>/dev/null) || line="$filepath   (unreadable)"
        block+="$line"$'\n'
    done

    if [[ -n "$label" ]]; then
        name_only+=("$label"$'\n'"$block")
    else
        confirmed+=("$block")
    fi
done

print_section() {
    local -n items=$1
    local first=true
    for item in "${items[@]}"; do
        if ! $first; then
            echo "---"
        fi
        first=false
        printf "%s" "$item"
    done
}

if [[ ${#confirmed[@]} -gt 0 ]]; then
    print_section confirmed
fi

if [[ ${#name_only[@]} -gt 0 ]]; then
    if [[ ${#confirmed[@]} -gt 0 ]]; then
        echo ""
    fi
    echo "========= NAME MATCH ONLY ========="
    local_first=true
    for item in "${name_only[@]}"; do
        label=$(echo "$item" | head -1)
        block=$(echo "$item" | tail -n +2)
        if ! $local_first; then
            echo "---"
        fi
        local_first=false
        echo "# $label"
        printf "%s" "$block"
    done
fi
