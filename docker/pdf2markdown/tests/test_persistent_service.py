from __future__ import annotations

import base64
import threading
import time
from pathlib import Path
from typing import Any

import fitz
from fastapi.testclient import TestClient

from pdf2markdown.persistent_service import (
    MistralKey,
    PersistentSettings,
    create_app,
)
from pdf2markdown.persistent_store import PersistentStore


PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk"
    "+A8AAQUBAScY42YAAAAASUVORK5CYII="
)
USER_HEADERS = {
    "Authorization": "Bearer client-secret",
    "X-PDF2Markdown-User-ID": "user-a",
}
OTHER_USER_HEADERS = {
    "Authorization": "Bearer client-secret",
    "X-PDF2Markdown-User-ID": "user-b",
}
ADMIN_HEADERS = {"Authorization": "Bearer admin-secret"}


def make_pdf(page_count: int = 1) -> bytes:
    document = fitz.open()
    for number in range(page_count):
        page = document.new_page()
        page.insert_text((72, 72), f"Page {number + 1}")
    content = document.tobytes()
    document.close()
    return content


class FakeProcessor:
    def __init__(self, delay: float = 0.0) -> None:
        self.delay = delay
        self.lock = threading.Lock()
        self.active = 0
        self.max_active = 0

    def __call__(
        self,
        job: dict[str, Any],
        key: MistralKey,
        settings: PersistentSettings,
        store: PersistentStore,
    ) -> str:
        assert key.secret == "test-mistral-key"
        with self.lock:
            self.active += 1
            self.max_active = max(self.max_active, self.active)
        try:
            if self.delay:
                time.sleep(self.delay)
            root = settings.data_root / job["storage_relpath"]
            result = root / "result" / "source"
            assets = result / "assets-hq"
            assets.mkdir(parents=True)
            (assets / "figure.png").write_bytes(PNG)
            markdown = result / "source-hq.md"
            markdown.write_text(
                "# Imported PDF\n\n![Figure](assets-hq/figure.png)\n",
                encoding="utf-8",
            )
            store.record_usage(
                job_id=job["job_id"],
                pages_processed=int(job["page_count"]),
                doc_size_bytes=(root / "source.pdf").stat().st_size,
                model=settings.model,
                outcome="ocr_completed",
            )
            return markdown.relative_to(root).as_posix()
        finally:
            with self.lock:
                self.active -= 1


def make_test_client(
    tmp_path: Path,
    *,
    processor: FakeProcessor | None = None,
    max_workers: int = 2,
) -> tuple[TestClient, FakeProcessor]:
    fake = processor or FakeProcessor()
    settings = PersistentSettings(
        data_root=tmp_path / "data",
        work_root=tmp_path / "work",
        database_path=tmp_path / "data" / "service.db",
        api_token="client-secret",
        admin_token="admin-secret",
        signing_secret="signing-secret",
        require_auth=True,
        max_concurrent_jobs=max_workers,
        max_queued_jobs=20,
    )
    key = MistralKey(
        key_id="embedded",
        label="Test key",
        secret="test-mistral-key",
        fingerprint="testfingerprint",
    )
    app = create_app(
        settings=settings,
        mistral_keys={key.key_id: key},
        processor=fake,
    )
    return TestClient(app), fake


def submit_pdf(
    client: TestClient,
    *,
    headers: dict[str, str] = USER_HEADERS,
    pages: int = 1,
) -> dict[str, Any]:
    response = client.post(
        "/v1/imports/pdf",
        headers=headers,
        files={"file": ("book.pdf", make_pdf(pages), "application/pdf")},
    )
    assert response.status_code == 202, response.text
    return response.json()


def wait_for_job(
    client: TestClient,
    job_id: str,
    *,
    headers: dict[str, str] = USER_HEADERS,
) -> dict[str, Any]:
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        response = client.get(f"/v1/imports/{job_id}", headers=headers)
        assert response.status_code == 200
        job = response.json()
        if job["status"] in {"completed", "failed"}:
            return job
        time.sleep(0.02)
    raise AssertionError(f"Job {job_id} did not finish")


def test_pdf_import_creates_renderable_chat_and_signed_source(tmp_path: Path) -> None:
    client, _ = make_test_client(tmp_path)
    with client:
        imported = submit_pdf(client, pages=2)
        job = wait_for_job(client, imported["job_id"])
        assert job["status"] == "completed"

        chat = client.get(
            f"/v1/chats/{imported['chat_id']}",
            headers=USER_HEADERS,
        )
        assert chat.status_code == 200
        message = chat.json()["messages"][0]
        assert message["type"] == "pdf_import"
        assert "/assets-hq/figure.png?access_token=" in message["content_markdown"]
        assert message["source"]["page_count"] == 2

        source = client.get(message["source"]["url"])
        assert source.status_code == 200
        assert source.headers["content-type"] == "application/pdf"

        image_url = (
            message["content_markdown"]
            .split("](", 1)[1]
            .split(")", 1)[0]
        )
        image = client.get(image_url)
        assert image.status_code == 200
        assert image.content == PNG


def test_raw_pdf_upload_and_raw_markdown_are_available_to_locus(tmp_path: Path) -> None:
    client, _ = make_test_client(tmp_path)
    with client:
        response = client.post(
            "/v1/imports/pdf/raw",
            params={"filename": "streamed.pdf", "title": "Streamed import"},
            headers={**USER_HEADERS, "Content-Type": "application/pdf"},
            content=make_pdf(),
        )
        assert response.status_code == 202, response.text
        imported = response.json()
        assert wait_for_job(client, imported["job_id"])["status"] == "completed"

        markdown = client.get(
            f"/v1/documents/{imported['document_id']}/markdown",
            params={"raw": "true"},
            headers=USER_HEADERS,
        )
        assert markdown.status_code == 200
        assert "](assets-hq/figure.png)" in markdown.text
        assert "access_token=" not in markdown.text


def test_tenant_resources_are_not_visible_to_another_user(tmp_path: Path) -> None:
    client, _ = make_test_client(tmp_path)
    with client:
        imported = submit_pdf(client)
        wait_for_job(client, imported["job_id"])

        assert (
            client.get(
                f"/v1/imports/{imported['job_id']}",
                headers=OTHER_USER_HEADERS,
            ).status_code
            == 404
        )
        assert (
            client.get(
                f"/v1/chats/{imported['chat_id']}",
                headers=OTHER_USER_HEADERS,
            ).status_code
            == 404
        )


def test_worker_pool_processes_multiple_jobs_in_parallel(tmp_path: Path) -> None:
    processor = FakeProcessor(delay=0.15)
    client, _ = make_test_client(
        tmp_path,
        processor=processor,
        max_workers=2,
    )
    with client:
        imports = [submit_pdf(client) for _ in range(4)]
        jobs = [wait_for_job(client, item["job_id"]) for item in imports]
        assert all(job["status"] == "completed" for job in jobs)
        assert processor.max_active == 2


def test_usage_is_metered_and_user_and_key_caps_are_enforced(
    tmp_path: Path,
) -> None:
    client, _ = make_test_client(tmp_path)
    with client:
        imported = submit_pdf(client, pages=2)
        assert wait_for_job(client, imported["job_id"])["status"] == "completed"

        usage = client.get("/v1/admin/usage", headers=ADMIN_HEADERS)
        assert usage.status_code == 200
        assert usage.json()["pages_processed"] == 2
        assert usage.json()["api_calls"] == 1
        assert usage.json()["api_keys"][0]["fingerprint"] == "testfingerprint"

        user_limit = client.patch(
            "/v1/admin/users/user-a/limits",
            headers=ADMIN_HEADERS,
            json={"monthly_page_cap": 2},
        )
        assert user_limit.status_code == 200
        blocked_user = client.post(
            "/v1/imports/pdf",
            headers=USER_HEADERS,
            files={"file": ("blocked.pdf", make_pdf(), "application/pdf")},
        )
        assert blocked_user.status_code == 429

        client.patch(
            "/v1/admin/users/user-a/limits",
            headers=ADMIN_HEADERS,
            json={"monthly_page_cap": None},
        )
        key_limit = client.patch(
            "/v1/admin/api-keys/embedded/limits",
            headers=ADMIN_HEADERS,
            json={"monthly_page_cap": 2},
        )
        assert key_limit.status_code == 200
        blocked_key = client.post(
            "/v1/imports/pdf",
            headers=USER_HEADERS,
            files={"file": ("blocked.pdf", make_pdf(), "application/pdf")},
        )
        assert blocked_key.status_code == 429


def test_client_and_admin_authentication_are_separate(tmp_path: Path) -> None:
    client, _ = make_test_client(tmp_path)
    with client:
        assert client.get("/v1/admin/usage", headers=USER_HEADERS).status_code == 401
        assert (
            client.post(
                "/v1/imports/pdf",
                headers={
                    "Authorization": "Bearer admin-secret",
                    "X-PDF2Markdown-User-ID": "user-a",
                },
                files={"file": ("book.pdf", make_pdf(), "application/pdf")},
            ).status_code
            == 401
        )


def test_pending_page_reservation_prevents_concurrent_quota_race(
    tmp_path: Path,
) -> None:
    processor = FakeProcessor(delay=0.2)
    client, _ = make_test_client(tmp_path, processor=processor, max_workers=1)
    with client:
        limit = client.patch(
            "/v1/admin/users/user-a/limits",
            headers=ADMIN_HEADERS,
            json={"monthly_page_cap": 1},
        )
        assert limit.status_code == 200
        first = submit_pdf(client)
        second = client.post(
            "/v1/imports/pdf",
            headers=USER_HEADERS,
            files={"file": ("second.pdf", make_pdf(), "application/pdf")},
        )
        assert second.status_code == 429
        assert wait_for_job(client, first["job_id"])["status"] == "completed"


def test_unknown_failed_call_is_conservatively_estimated_for_quota(
    tmp_path: Path,
) -> None:
    def failing_processor(
        job: dict[str, Any],
        key: MistralKey,
        settings: PersistentSettings,
        store: PersistentStore,
    ) -> str:
        raise RuntimeError("upstream connection ended without usage metadata")

    settings = PersistentSettings(
        data_root=tmp_path / "data",
        work_root=tmp_path / "work",
        database_path=tmp_path / "data" / "service.db",
        api_token="client-secret",
        admin_token="admin-secret",
        signing_secret="signing-secret",
        max_concurrent_jobs=1,
    )
    key = MistralKey(
        key_id="embedded",
        label="Test key",
        secret="test-mistral-key",
        fingerprint="testfingerprint",
    )
    client = TestClient(
        create_app(
            settings=settings,
            mistral_keys={key.key_id: key},
            processor=failing_processor,
        )
    )
    with client:
        imported = submit_pdf(client, pages=2)
        assert wait_for_job(client, imported["job_id"])["status"] == "failed"
        usage = client.get("/v1/admin/usage", headers=ADMIN_HEADERS).json()
        assert usage["pages_processed"] == 0
        assert usage["quota_pages"] == 2
        assert usage["estimated_pages"] == 2
