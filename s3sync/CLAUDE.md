# AWS S3 Backup Project

This directory is synced to/from S3 bucket `s3://tine-pc-backup` using the AWS CLI.

## Scripts

- **s3sync_upload.sh** - Syncs local files up to S3 (local is source of truth)
- **s3sync_download.sh** - Syncs S3 files down to local (S3 is source of truth)
- **s3sync_test.sh** - Checks for files out of sync between local and S3 (dry run, no changes)
- **s3sync_offload.sh** - Uploads a directory to S3, deletes local copies, and prevents auto-re-download
- **s3sync_notes.txt** - Quick reference notes

## Offload Files

- **.s3download-ignore** - Paths excluded from auto-download (populated by `s3sync_offload.sh`)
- **.s3upload-ignore** - Paths excluded from auto-upload (manually managed; pre-populated with `*remote_files.md`)
- **remote_files.md** (per-directory) - Local reference listing what files are stored in S3; never uploaded

## Common Usage

### Check sync status (no changes made)
```bash
./s3sync_test.sh
```

### Upload local changes to S3
```bash
./s3sync_upload.sh
# With --delete to remove files in S3 that were deleted locally:
./s3sync_upload.sh --delete
# Limit to specific files:
./s3sync_upload.sh --exclude "*" --include "file1.txt"
```

### Download from S3 to local
```bash
./s3sync_download.sh
# With --delete to remove local files that were deleted from S3:
./s3sync_download.sh --delete
# Limit to specific files:
./s3sync_download.sh --exclude "*" --include "file1.txt"
```

### Offload a directory to S3 (free local disk space)
```bash
./s3sync_offload.sh Videos/
# Multiple paths at once:
./s3sync_offload.sh Videos/ Archives/2023/
```
- Uploads all files to S3, verifies each one, then deletes local copies
- Creates `Videos/remote_files.md` listing what's in S3
- Adds `Videos/` to `.s3download-ignore` so it won't be re-downloaded automatically
- To manually restore: `./s3sync_download.sh --include "Videos/*"`

### Bootstrap on a new machine (get these scripts from S3)
```bash
aws s3 cp s3://tine-pc-backup/s3sync_notes.txt .
aws s3 cp s3://tine-pc-backup/s3sync_download.sh .
aws s3 cp s3://tine-pc-backup/s3sync_test.sh .
aws s3 cp s3://tine-pc-backup/s3sync_upload.sh .
```

## Notes

- The `-f` flag in all scripts disables glob expansion so `*` can be passed as a parameter
- `s3sync_test.sh` handles filenames with spaces correctly; avoid filenames containing the standalone word `to`
- Filenames with spaces are supported in upload/download with `--include`/`--exclude` patterns

## S3 Storage Costs (approximate)

| Tier | Cost |
|------|------|
| Standard (first 14 days) | $0.023/GB/month ($0.27/GB/year) |
| Glacier Infrequent Retrieval (after 14 days) | $0.004/GB/month ($0.048/GB/year) |
