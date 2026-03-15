# Find duplicate files

This script will find all the duplicate files that exist inside of two directories.  This script takes two directories as command line parameters and it will recursively find all the files under the parent directory.  If it finds any files with the same name, it will print out the two filenames, last-modified date and size.

The goal of this script is to help find two files that are duplicates.  It's especially useful in finding cases where the same photo or video are stored in two different directories.

NOTE: It's possible to pass a single directory as the command line parameter.  In that case, the script will find the duplicate files under that directory.

## Input

For multiple directories:
```bash
findDups dir1 dir2
```

For a single directory:
```bash
findDups dir1
```

## Output

The output of the script is the location(s) of duplicate files, like:

```
dir1/subdirABC/IMG_001.jpg   Sat Mar 14 19:26:15.1398341960 2026 4096
dir2/subdirDEF/IMG_001.jpg   Sat Mar 14 19:26:15.1398341960 2026 4096
---
dir1/subdirABC/IMG_051.jpg   Sat Mar 14 19:26:15.1398341960 2026 4096
dir2/subdirDEF/IMG_051.jpg   Sat Mar 14 19:26:15.1398341960 2026 4096
```