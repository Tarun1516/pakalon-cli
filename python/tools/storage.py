"""
storage.py — Cloud storage tools for Pakalon agents.
T-CLI-P14: MinIO (S3-compatible) + Cloudinary upload/download/list/delete.

Priority: MinIO (self-hosted S3) → Cloudinary.
"""
from __future__ import annotations

import io
import mimetypes
import os
import pathlib
import uuid
from typing import Any


# ---------------------------------------------------------------------------
# Storage providers
# ---------------------------------------------------------------------------

STORAGE_PROVIDER_PRIORITY = ["minio", "cloudinary"]

# MinIO / S3 env vars
# MINIO_ENDPOINT   e.g. "http://localhost:9000"  or AWS S3 "https://s3.amazonaws.com"
# MINIO_ACCESS_KEY
# MINIO_SECRET_KEY
# MINIO_BUCKET     default: "pakalon"
# MINIO_REGION     default: "us-east-1"
# MINIO_SECURE     "true" | "false"

# Cloudinary env vars
# CLOUDINARY_CLOUD_NAME
# CLOUDINARY_API_KEY
# CLOUDINARY_API_SECRET

_MINIO_BUCKET = os.environ.get("MINIO_BUCKET", "pakalon")
_MINIO_REGION = os.environ.get("MINIO_REGION", "us-east-1")


# ---------------------------------------------------------------------------
# StorageTool
# ---------------------------------------------------------------------------

class StorageTool:
    """
    Unified interface for uploading, downloading, listing, and deleting
    files in MinIO/S3 or Cloudinary.
    """

    # ---- Public API --------------------------------------------------------

    def upload(
        self,
        local_path: str,
        remote_key: str | None = None,
        provider: str | None = None,
        public: bool = True,
    ) -> dict[str, Any]:
        """
        Upload a local file to cloud storage.

        Returns: {success, url, provider, remote_key, error}
        """
        file_path = pathlib.Path(local_path)
        if not file_path.exists():
            return {"success": False, "error": f"File not found: {local_path}"}

        key = remote_key or f"pakalon/{uuid.uuid4().hex[:8]}/{file_path.name}"

        providers = [provider] if provider else self._choose_providers()
        for prov in providers:
            if prov == "minio":
                result = self._upload_minio(file_path, key, public)
            elif prov == "cloudinary":
                result = self._upload_cloudinary(file_path, key)
            else:
                continue
            if result.get("success"):
                return result

        return {"success": False, "error": "All storage providers failed or have no credentials"}

    def download(
        self,
        remote_key: str,
        local_path: str | None = None,
        provider: str | None = None,
    ) -> dict[str, Any]:
        """
        Download a remote file to disk.

        Returns: {success, local_path, provider, error}
        """
        providers = [provider] if provider else self._choose_providers()
        for prov in providers:
            if prov == "minio":
                result = self._download_minio(remote_key, local_path)
            elif prov == "cloudinary":
                result = self._download_cloudinary(remote_key, local_path)
            else:
                continue
            if result.get("success"):
                return result

        return {"success": False, "error": "Download failed on all providers"}

    def delete(self, remote_key: str, provider: str | None = None) -> dict[str, Any]:
        """
        Delete a remote file.

        Returns: {success, provider, error}
        """
        providers = [provider] if provider else self._choose_providers()
        for prov in providers:
            if prov == "minio":
                result = self._delete_minio(remote_key)
            elif prov == "cloudinary":
                result = self._delete_cloudinary(remote_key)
            else:
                continue
            if result.get("success"):
                return result

        return {"success": False, "error": "Delete failed on all providers"}

    def list_files(
        self, prefix: str = "", provider: str | None = None
    ) -> dict[str, Any]:
        """
        List remote files under a prefix.

        Returns: {success, files: [{key, size, last_modified}], provider, error}
        """
        providers = [provider] if provider else self._choose_providers()
        for prov in providers:
            if prov == "minio":
                result = self._list_minio(prefix)
            elif prov == "cloudinary":
                result = self._list_cloudinary(prefix)
            else:
                continue
            if result.get("success"):
                return result

        return {"success": False, "files": [], "error": "List failed on all providers"}

    # ---- Provider selection ------------------------------------------------

    def _choose_providers(self) -> list[str]:
        ordered: list[str] = []
        if os.environ.get("MINIO_ACCESS_KEY") or os.environ.get("AWS_ACCESS_KEY_ID"):
            ordered.append("minio")
        if os.environ.get("CLOUDINARY_API_KEY"):
            ordered.append("cloudinary")
        # If nothing is configured, return full list so each fails with a clear message
        return ordered or STORAGE_PROVIDER_PRIORITY

    # ---- MinIO / S3 --------------------------------------------------------

    def _get_s3_client(self) -> Any:
        """Return a boto3 S3 client using MINIO_* or AWS_* env vars."""
        try:
            import boto3  # type: ignore
        except ImportError as e:
            raise RuntimeError("boto3 not installed. Run: pip install boto3") from e

        endpoint = os.environ.get("MINIO_ENDPOINT") or os.environ.get("S3_ENDPOINT")
        access_key = os.environ.get("MINIO_ACCESS_KEY") or os.environ.get("AWS_ACCESS_KEY_ID")
        secret_key = os.environ.get("MINIO_SECRET_KEY") or os.environ.get("AWS_SECRET_ACCESS_KEY")

        kwargs: dict[str, Any] = {
            "region_name": _MINIO_REGION,
            "aws_access_key_id": access_key,
            "aws_secret_access_key": secret_key,
        }
        if endpoint:
            kwargs["endpoint_url"] = endpoint

        return boto3.client("s3", **{k: v for k, v in kwargs.items() if v})

    def _upload_minio(self, file_path: pathlib.Path, key: str, public: bool) -> dict[str, Any]:
        try:
            s3 = self._get_s3_client()
            bucket = _MINIO_BUCKET
            content_type, _ = mimetypes.guess_type(str(file_path))
            extra: dict[str, Any] = {"ContentType": content_type or "application/octet-stream"}
            if public:
                extra["ACL"] = "public-read"

            s3.upload_file(str(file_path), bucket, key, ExtraArgs=extra)

            endpoint = os.environ.get("MINIO_ENDPOINT", "")
            if endpoint:
                url = f"{endpoint.rstrip('/')}/{bucket}/{key}"
            else:
                url = f"https://{bucket}.s3.{_MINIO_REGION}.amazonaws.com/{key}"

            return {"success": True, "url": url, "provider": "minio", "remote_key": key}
        except Exception as exc:
            return {"success": False, "provider": "minio", "error": str(exc)}

    def _download_minio(self, key: str, local_path: str | None) -> dict[str, Any]:
        try:
            s3 = self._get_s3_client()
            bucket = _MINIO_BUCKET
            dest = local_path or f"/tmp/pakalon-dl-{uuid.uuid4().hex[:8]}-{pathlib.Path(key).name}"
            pathlib.Path(dest).parent.mkdir(parents=True, exist_ok=True)
            s3.download_file(bucket, key, dest)
            return {"success": True, "local_path": dest, "provider": "minio"}
        except Exception as exc:
            return {"success": False, "provider": "minio", "error": str(exc)}

    def _delete_minio(self, key: str) -> dict[str, Any]:
        try:
            s3 = self._get_s3_client()
            s3.delete_object(Bucket=_MINIO_BUCKET, Key=key)
            return {"success": True, "provider": "minio"}
        except Exception as exc:
            return {"success": False, "provider": "minio", "error": str(exc)}

    def _list_minio(self, prefix: str) -> dict[str, Any]:
        try:
            s3 = self._get_s3_client()
            resp = s3.list_objects_v2(Bucket=_MINIO_BUCKET, Prefix=prefix)
            files = [
                {
                    "key": obj["Key"],
                    "size": obj.get("Size", 0),
                    "last_modified": obj.get("LastModified", "").isoformat()
                    if hasattr(obj.get("LastModified", ""), "isoformat")
                    else str(obj.get("LastModified", "")),
                }
                for obj in resp.get("Contents", [])
            ]
            return {"success": True, "files": files, "provider": "minio"}
        except Exception as exc:
            return {"success": False, "provider": "minio", "files": [], "error": str(exc)}

    # ---- Cloudinary --------------------------------------------------------

    def _get_cloudinary(self) -> Any:
        """Return configured cloudinary module."""
        try:
            import cloudinary  # type: ignore
            import cloudinary.uploader  # type: ignore
            import cloudinary.api  # type: ignore

            cloudinary.config(
                cloud_name=os.environ.get("CLOUDINARY_CLOUD_NAME"),
                api_key=os.environ.get("CLOUDINARY_API_KEY"),
                api_secret=os.environ.get("CLOUDINARY_API_SECRET"),
            )
            return cloudinary
        except ImportError as e:
            raise RuntimeError("cloudinary not installed. Run: pip install cloudinary") from e

    def _upload_cloudinary(self, file_path: pathlib.Path, key: str) -> dict[str, Any]:
        try:
            cld = self._get_cloudinary()
            import cloudinary.uploader  # type: ignore

            # Use key as public_id (strip extension and convert slashes)
            public_id = key.replace("/", "_").rsplit(".", 1)[0]
            result = cloudinary.uploader.upload(str(file_path), public_id=public_id)
            url = result.get("secure_url") or result.get("url")
            return {"success": True, "url": url, "provider": "cloudinary", "remote_key": public_id}
        except Exception as exc:
            return {"success": False, "provider": "cloudinary", "error": str(exc)}

    def _download_cloudinary(self, key: str, local_path: str | None) -> dict[str, Any]:
        try:
            import httpx

            # Construct the URL
            cloud = os.environ.get("CLOUDINARY_CLOUD_NAME", "")
            url = f"https://res.cloudinary.com/{cloud}/image/upload/{key}"
            dest = local_path or f"/tmp/pakalon-dl-{uuid.uuid4().hex[:8]}-{key.split('/')[-1]}"
            pathlib.Path(dest).parent.mkdir(parents=True, exist_ok=True)
            with httpx.Client(timeout=60) as client:
                r = client.get(url)
            if r.status_code != 200:
                return {"success": False, "provider": "cloudinary", "error": f"HTTP {r.status_code}"}
            pathlib.Path(dest).write_bytes(r.content)
            return {"success": True, "local_path": dest, "provider": "cloudinary"}
        except Exception as exc:
            return {"success": False, "provider": "cloudinary", "error": str(exc)}

    def _delete_cloudinary(self, key: str) -> dict[str, Any]:
        try:
            cld = self._get_cloudinary()
            import cloudinary.uploader  # type: ignore

            result = cloudinary.uploader.destroy(key)
            ok = result.get("result") == "ok"
            return {"success": ok, "provider": "cloudinary", "error": None if ok else result.get("result")}
        except Exception as exc:
            return {"success": False, "provider": "cloudinary", "error": str(exc)}

    def get_signed_url(
        self,
        remote_key: str,
        expiry_seconds: int = 7 * 24 * 3600,  # 7 days default
        provider: str | None = None,
    ) -> dict[str, Any]:
        """
        T-MEDIA-03: Generate a pre-signed (time-limited) URL for a stored object.

        Used for free-tier users who should get 7-day expiring download links
        instead of permanent public URLs.

        Returns: {success, url, expires_in_seconds, provider, error}
        """
        providers = [provider] if provider else self._choose_providers()
        for prov in providers:
            if prov == "minio":
                result = self._signed_url_minio(remote_key, expiry_seconds)
            elif prov == "cloudinary":
                result = self._signed_url_cloudinary(remote_key, expiry_seconds)
            else:
                continue
            if result.get("success"):
                return result
        return {"success": False, "error": "Could not generate signed URL on any provider"}

    def upload_for_tier(
        self,
        local_path: str,
        remote_key: str | None = None,
        is_pro: bool = True,
    ) -> dict[str, Any]:
        """
        T-MEDIA-03: Upload and return appropriate URL based on subscription tier.

        - Pro users: permanent public CDN URL
        - Free users: 7-day pre-signed URL

        Returns: {success, url, url_type ("public"|"signed"), expires_at, provider, error}
        """
        result = self.upload(local_path, remote_key=remote_key, public=is_pro)
        if not result.get("success"):
            return result

        if is_pro:
            result["url_type"] = "public"
            result["expires_at"] = None
            return result

        # Free tier: replace public URL with 7-day signed URL
        key = result.get("remote_key", "")
        signed = self.get_signed_url(key, expiry_seconds=7 * 24 * 3600, provider=result.get("provider"))
        if signed.get("success"):
            from datetime import datetime, timedelta, timezone
            result["url"] = signed["url"]
            result["url_type"] = "signed"
            result["expires_at"] = (
                datetime.now(tz=timezone.utc) + timedelta(seconds=7 * 24 * 3600)
            ).isoformat()
        else:
            result["url_type"] = "public"  # fallback: keep the public URL
            result["expires_at"] = None
        return result

    # ---- Signed URL helpers ------------------------------------------------

    def _signed_url_minio(self, key: str, expiry_seconds: int) -> dict[str, Any]:
        try:
            s3 = self._get_s3_client()
            url = s3.generate_presigned_url(
                "get_object",
                Params={"Bucket": _MINIO_BUCKET, "Key": key},
                ExpiresIn=expiry_seconds,
            )
            return {"success": True, "url": url, "expires_in_seconds": expiry_seconds, "provider": "minio"}
        except Exception as exc:
            return {"success": False, "provider": "minio", "error": str(exc)}

    def _signed_url_cloudinary(self, key: str, expiry_seconds: int) -> dict[str, Any]:
        try:
            import time
            cld = self._get_cloudinary()
            import cloudinary  # type: ignore

            expires_at = int(time.time()) + expiry_seconds
            # Generate a signed delivery URL using Cloudinary's SDK
            url = cloudinary.utils.cloudinary_url(
                key,
                sign_url=True,
                type="authenticated",
                expires_at=expires_at,
            )[0]
            return {"success": True, "url": url, "expires_in_seconds": expiry_seconds, "provider": "cloudinary"}
        except Exception as exc:
            return {"success": False, "provider": "cloudinary", "error": str(exc)}

    def _list_cloudinary(self, prefix: str) -> dict[str, Any]:
        try:
            cld = self._get_cloudinary()
            import cloudinary.api  # type: ignore

            result = cloudinary.api.resources(prefix=prefix or "pakalon", max_results=100)
            files = [
                {
                    "key": r.get("public_id"),
                    "size": r.get("bytes", 0),
                    "last_modified": r.get("created_at", ""),
                    "url": r.get("secure_url"),
                }
                for r in result.get("resources", [])
            ]
            return {"success": True, "files": files, "provider": "cloudinary"}
        except Exception as exc:
            return {"success": False, "provider": "cloudinary", "files": [], "error": str(exc)}
