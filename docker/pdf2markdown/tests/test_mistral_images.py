from __future__ import annotations

from io import BytesIO

import fitz
from PIL import Image

from pdf2markdown.mistral_images import (
    _pixmap_png_bytes,
    repair_transformed_embedded_images,
    upgrade_document_images,
)


def test_png_encoder_converts_cmyk_pixmaps_to_rgb() -> None:
    pixmap = fitz.Pixmap(fitz.csCMYK, fitz.IRect(0, 0, 3, 2), False)
    pixmap.clear_with(128)

    encoded = _pixmap_png_bytes(pixmap)

    with Image.open(BytesIO(encoded)) as image:
        assert image.format == "PNG"
        assert image.mode == "RGB"
        assert image.size == (3, 2)


def test_png_encoder_preserves_supported_rgb_alpha() -> None:
    pixmap = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 2, 3), True)
    pixmap.clear_with(64)

    encoded = _pixmap_png_bytes(pixmap)

    with Image.open(BytesIO(encoded)) as image:
        assert image.format == "PNG"
        assert image.mode == "RGBA"
        assert image.size == (2, 3)


def test_image_recovery_failure_keeps_original_ocr_preview(
    tmp_path,
    monkeypatch,
) -> None:
    pdf_path = tmp_path / "source.pdf"
    with fitz.open() as document:
        document.new_page(width=200, height=300)
        document.save(pdf_path)

    result_dir = tmp_path / "result"
    pages_dir = result_dir / "pages"
    assets_dir = result_dir / "assets"
    pages_dir.mkdir(parents=True)
    assets_dir.mkdir()
    old_path = "assets/page-0001-figure.png"
    Image.new("RGB", (4, 3), "white").save(result_dir / old_path)
    markdown = f"# Page\n\n![Figure]({old_path})\n"
    (pages_dir / "page-0001.md").write_text(markdown, encoding="utf-8")
    (result_dir / "response.json").write_text(
        """{
  "pages": [{
    "index": 0,
    "dimensions": {"width": 200, "height": 300},
    "images": [{
      "id": "figure.png",
      "asset_path": "assets/page-0001-figure.png",
      "top_left_x": 20,
      "top_left_y": 30,
      "bottom_right_x": 180,
      "bottom_right_y": 220
    }]
  }]
}
""",
        encoding="utf-8",
    )

    def fail_render(*_args, **_kwargs):
        raise ValueError("synthetic recovery failure")

    monkeypatch.setattr(
        "pdf2markdown.mistral_images._render_pdf_region",
        fail_render,
    )

    output = upgrade_document_images(
        pdf_path,
        result_dir,
        center_images=False,
    )

    assert f"]({old_path})" in output.read_text(encoding="utf-8")
    report = __import__("json").loads(
        (result_dir / "image-upgrade-report.json").read_text(encoding="utf-8")
    )
    assert report["asset_count"] == 0
    assert report["failed_asset_count"] == 1
    assert report["failed_assets"][0]["image_id"] == "figure.png"
    assert "synthetic recovery failure" in report["failed_assets"][0]["error"]


def test_transformed_embedded_image_uses_rendered_page_appearance(
    tmp_path,
    monkeypatch,
) -> None:
    pdf_path = tmp_path / "source.pdf"
    with fitz.open() as document:
        document.new_page(width=200, height=300)
        document.save(pdf_path)

    result_dir = tmp_path / "result"
    pages_dir = result_dir / "pages"
    assets_dir = result_dir / "assets"
    pages_dir.mkdir(parents=True)
    assets_dir.mkdir()
    old_path = "assets/page-0001-figure.png"
    Image.new("RGB", (4, 3), "white").save(result_dir / old_path)
    (pages_dir / "page-0001.md").write_text(
        f"![Figure]({old_path})\n",
        encoding="utf-8",
    )
    (result_dir / "response.json").write_text(
        """{
  "pages": [{
    "index": 0,
    "dimensions": {"width": 200, "height": 300},
    "images": [{
      "id": "figure.png",
      "asset_path": "assets/page-0001-figure.png",
      "top_left_x": 20,
      "top_left_y": 30,
      "bottom_right_x": 180,
      "bottom_right_y": 220
    }]
  }]
}
""",
        encoding="utf-8",
    )
    transformed = {
        "xref": 42,
        "bbox": (20, 30, 180, 220),
        "transform": (160, 0, 0, -190, 20, 220),
        "width": 4,
        "height": 3,
    }
    monkeypatch.setattr(
        "pdf2markdown.mistral_images.choose_embedded_image",
        lambda *_args, **_kwargs: transformed,
    )
    monkeypatch.setattr(
        "pdf2markdown.mistral_images.choose_page_scan",
        lambda *_args, **_kwargs: None,
    )

    def render_page(_page, rect, output_path, *_args, **_kwargs):
        Image.new("RGB", (12, 8), "blue").save(output_path, format="PNG")
        return 12, 8, rect

    monkeypatch.setattr(
        "pdf2markdown.mistral_images._render_pdf_region",
        render_page,
    )

    upgrade_document_images(pdf_path, result_dir, center_images=False)

    report = __import__("json").loads(
        (result_dir / "image-upgrade-report.json").read_text(encoding="utf-8")
    )
    assert report["schema_version"] == 3
    assert report["assets"][0]["method"].endswith("transformed-image")
    assert report["assets"][0]["new_width"] == 12


def test_legacy_transformed_asset_is_repaired_in_place(
    tmp_path,
    monkeypatch,
) -> None:
    pdf_path = tmp_path / "source.pdf"
    with fitz.open() as document:
        document.new_page(width=200, height=300)
        document.save(pdf_path)
    result_dir = tmp_path / "result"
    asset = result_dir / "assets-hq" / "figure.png"
    asset.parent.mkdir(parents=True)
    Image.new("RGB", (4, 3), "red").save(asset)
    report_path = result_dir / "image-upgrade-report.json"
    report_path.write_text(
        """{
  "schema_version": 2,
  "assets": [{
    "page": 1,
    "method": "embedded-image-lossless",
    "new_path": "assets-hq/figure.png",
    "source_xref": 42,
    "pdf_bbox": [20, 30, 180, 220]
  }]
}
""",
        encoding="utf-8",
    )
    class FakePage:
        def get_image_info(self, **_kwargs):
            return [{
                "xref": 42,
                "transform": (160, 0, 0, -190, 20, 220),
            }]

    class FakeDocument:
        page_count = 1

        def load_page(self, _index):
            return FakePage()

        def close(self):
            return None

    monkeypatch.setattr(
        "pdf2markdown.mistral_images.fitz.open",
        lambda *_args, **_kwargs: FakeDocument(),
    )

    def render_page(_page, rect, output_path, *_args, **_kwargs):
        Image.new("RGB", (20, 10), "green").save(output_path, format="PNG")
        return 20, 10, rect

    monkeypatch.setattr(
        "pdf2markdown.mistral_images._render_pdf_region",
        render_page,
    )

    assert repair_transformed_embedded_images(pdf_path, result_dir) == 1

    report = __import__("json").loads(report_path.read_text(encoding="utf-8"))
    assert report["schema_version"] == 3
    assert report["orientation_repair_count"] == 1
    assert report["assets"][0]["new_width"] == 20
    with Image.open(asset) as repaired:
        assert repaired.size == (20, 10)
