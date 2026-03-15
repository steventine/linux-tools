#!/bin/bash
# findDups.sh - Find duplicate files across one or two directory trees.
#
# By default, matches files by name only (case-insensitive). This is fast and
# works with remote filesystems like OneDrive where file content may not be
# locally available.
#
# Optional flags:
#   --size  Check that file sizes match. Files with the same name but different
#           sizes are reported separately under "NAME MATCH ONLY".
#   --hash  Compute md5sum to confirm content is identical. Files with matching
#           names but different hashes are reported under "NAME MATCH ONLY".
#           Unreadable files (e.g. OneDrive placeholders) are flagged separately.
#
# Usage: findDups.sh [--hash] [--size] dir1 [dir2]

# --- Parse arguments ---

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

# --- Build a map of lowercase basename -> newline-separated list of full paths ---
# Using lowercase keys makes matching case-insensitive (e.g. IMG_001.JPG == img_001.jpg).

declare -A file_groups

while IFS= read -r filepath; do
    lower_basename=$(basename "$filepath" | tr '[:upper:]' '[:lower:]')
    if [[ -z "${file_groups[$lower_basename]}" ]]; then
        file_groups[$lower_basename]="$filepath"
    else
        file_groups[$lower_basename]+=$'\n'"$filepath"
    fi
done < <(find "${DIRS[@]}" -type f | sort)

# --- Classify each group as a confirmed duplicate or name-only match ---
# Results are collected into parallel arrays so confirmed duplicates and
# name-only matches can be printed in separate sections at the end.

confirmed_blocks=()
name_only_labels=()
name_only_blocks=()

for key in $(echo "${!file_groups[@]}" | tr ' ' '\n' | sort); do
    mapfile -t paths <<< "${file_groups[$key]}"

    # Skip filenames that only appear once — not a duplicate
    if [[ ${#paths[@]} -lt 2 ]]; then
        continue
    fi

    # label is set to a non-empty string if this group is a name-only match
    label=""

    # --size: flag the group if any two files have different sizes
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

    # --hash: if sizes matched (or --size wasn't used), verify content via md5sum.
    # Skip if label is already set (size mismatch already disqualifies the group).
    if [[ -z "$label" ]] && $USE_HASH; then
        first_hash=""
        all_same=true
        has_unreadable=false

        for filepath in "${paths[@]}"; do
            if [[ ! -r "$filepath" ]]; then
                # File exists but content is unavailable (e.g. OneDrive placeholder)
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

    # Build the formatted output block for this group.
    # Paths are padded to the same width so dates and sizes line up in columns.
    g_paths=()
    g_dates=()
    g_sizes=()
    max_len=0

    for filepath in "${paths[@]}"; do
        if stat_out=$(stat --printf="%y\t%s" "$filepath" 2>/dev/null); then
            # Split "mtime\tsize" using parameter expansion (avoids subshell forks)
            g_dates+=("${stat_out%$'\t'*}")
            g_sizes+=("${stat_out##*$'\t'}")
        else
            g_dates+=("(unreadable)")
            g_sizes+=("")
        fi
        g_paths+=("$filepath")
        (( ${#filepath} > max_len )) && max_len=${#filepath}
    done

    block=""
    for i in "${!g_paths[@]}"; do
        # $() strips trailing newlines, so we re-add with $'\n'
        block+=$(printf "%-${max_len}s  %s %s" "${g_paths[$i]}" "${g_dates[$i]}" "${g_sizes[$i]}")
        block+=$'\n'
    done

    if [[ -n "$label" ]]; then
        name_only_labels+=("$label")
        name_only_blocks+=("$block")
    else
        confirmed_blocks+=("$block")
    fi
done

# --- Print results ---

# Print an array of blocks separated by "---"
print_blocks() {
    local -n blocks=$1
    local first=true
    for block in "${blocks[@]}"; do
        $first || echo "---"
        first=false
        printf "%s" "$block"
    done
}

# Confirmed duplicates first
if [[ ${#confirmed_blocks[@]} -gt 0 ]]; then
    print_blocks confirmed_blocks
fi

# Name-only matches in a clearly separated section at the end
if [[ ${#name_only_blocks[@]} -gt 0 ]]; then
    [[ ${#confirmed_blocks[@]} -gt 0 ]] && echo ""
    echo "========= NAME MATCH ONLY ========="
    first=true
    for i in "${!name_only_blocks[@]}"; do
        $first || echo "---"
        first=false
        echo "# ${name_only_labels[$i]}"
        printf "%s" "${name_only_blocks[$i]}"
    done
fi
