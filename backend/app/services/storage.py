"""Cloudflare R2 storage (S3 API). Postgres stores keys; bytes live here.

Locally, point R2_ENDPOINT_URL at MinIO and nothing else changes.
"""

import hashlib
import mimetypes
import re
import uuid
from functools import cached_property

import boto3
from botocore.client import Config
from botocore.exceptions import ClientError

from app.config import settings


class keys:  # noqa: N801  (namespace for key builders)
    @staticmethod
    def raw_html(workspace_id: uuid.UUID, source_id: uuid.UUID, document_id: uuid.UUID) -> str:
        return f"ws/{workspace_id}/sources/{source_id}/documents/{document_id}/raw.html"

    @staticmethod
    def upload(workspace_id: uuid.UUID, upload_id: uuid.UUID, filename: str) -> str:
        return f"ws/{workspace_id}/uploads/{upload_id}/{safe_filename(filename)}"

    @staticmethod
    def artifact(workspace_id: uuid.UUID, artifact_id: uuid.UUID, variant: str, ext: str) -> str:
        return f"ws/{workspace_id}/artifacts/{artifact_id}/{variant}.{ext.lstrip('.')}"

    @staticmethod
    def tts_cache(workspace_id: uuid.UUID, script: str, voice_id: str, settings_json: str) -> str:
        digest = hashlib.sha256(f"{script}|{voice_id}|{settings_json}".encode()).hexdigest()
        return f"ws/{workspace_id}/tts-cache/{digest}.mp3"

    @staticmethod
    def dspy_program(module: str, version: str) -> str:
        return f"system/dspy/{module}/{version}.json"


def safe_filename(name: str) -> str:
    name = name.rsplit("/", 1)[-1].rsplit("\\", 1)[-1]
    name = re.sub(r"[^A-Za-z0-9._-]+", "-", name).strip("-.")
    return name[:120] or "file"


def workspace_owns_key(workspace_id: uuid.UUID, key: str) -> bool:
    return key.startswith(f"ws/{workspace_id}/") and ".." not in key


class Storage:
    def __init__(self, bucket: str | None = None):
        self.bucket = bucket or settings.r2_bucket

    @cached_property
    def client(self):
        return boto3.client(
            "s3",
            endpoint_url=settings.r2_endpoint,
            aws_access_key_id=settings.r2_access_key_id,
            aws_secret_access_key=settings.r2_secret_access_key,
            region_name="auto",
            config=Config(signature_version="s3v4", s3={"addressing_style": "path"}),
        )

    def ensure_bucket(self) -> None:
        """Local dev convenience (MinIO). On R2 create the bucket in the dashboard."""
        try:
            self.client.head_bucket(Bucket=self.bucket)
        except ClientError:
            self.client.create_bucket(Bucket=self.bucket)

    def put_bytes(self, key: str, data: bytes, content_type: str | None = None) -> str:
        content_type = content_type or mimetypes.guess_type(key)[0] or "application/octet-stream"
        self.client.put_object(Bucket=self.bucket, Key=key, Body=data, ContentType=content_type)
        return key

    def put_text(self, key: str, text: str, content_type: str = "text/plain; charset=utf-8") -> str:
        return self.put_bytes(key, text.encode("utf-8"), content_type)

    def get_bytes(self, key: str) -> bytes:
        return self.client.get_object(Bucket=self.bucket, Key=key)["Body"].read()

    def head(self, key: str) -> dict | None:
        try:
            return self.client.head_object(Bucket=self.bucket, Key=key)
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") in {"404", "NoSuchKey", "NotFound"}:
                return None
            raise

    def exists(self, key: str) -> bool:
        return self.head(key) is not None

    def delete(self, key: str) -> None:
        self.client.delete_object(Bucket=self.bucket, Key=key)

    def delete_prefix(self, prefix: str) -> int:
        deleted = 0
        paginator = self.client.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=self.bucket, Prefix=prefix):
            objects = [{"Key": o["Key"]} for o in page.get("Contents", [])]
            if objects:
                self.client.delete_objects(Bucket=self.bucket, Delete={"Objects": objects})
                deleted += len(objects)
        return deleted

    def presign_get(self, key: str, ttl: int | None = None, download_name: str | None = None) -> str:
        params = {"Bucket": self.bucket, "Key": key}
        if download_name:
            params["ResponseContentDisposition"] = f'attachment; filename="{safe_filename(download_name)}"'
        return self.client.generate_presigned_url(
            "get_object", Params=params, ExpiresIn=ttl or settings.r2_presign_ttl_seconds
        )

    def presign_put(self, key: str, content_type: str, ttl: int | None = None) -> str:
        return self.client.generate_presigned_url(
            "put_object",
            Params={"Bucket": self.bucket, "Key": key, "ContentType": content_type},
            ExpiresIn=ttl or settings.r2_presign_ttl_seconds,
        )

    def public_url(self, key: str) -> str | None:
        if not settings.r2_public_base_url:
            return None
        return f"{settings.r2_public_base_url.rstrip('/')}/{key}"


storage = Storage()
