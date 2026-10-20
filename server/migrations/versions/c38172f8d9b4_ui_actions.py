"""Persist short-lived interface actions and their execution receipts."""
from alembic import op
import sqlalchemy as sa

revision = "c38172f8d9b4"
down_revision = "a26b10f14f01"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table("ui_actions",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("session_id", sa.String(36), sa.ForeignKey("visitor_sessions.id"), nullable=False),
        sa.Column("client_request_id", sa.String(36), nullable=False),
        sa.Column("request_hash", sa.String(64), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("action_type", sa.String(40), nullable=False),
        sa.Column("item_id", sa.String(64), nullable=True),
        sa.Column("hotspot_id", sa.String(64), nullable=True),
        sa.Column("status", sa.String(24), nullable=False),
        sa.Column("receipt", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("expires_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("session_id", "client_request_id", name="uq_ui_action_request"))
    op.create_index("ix_ui_actions_session_id", "ui_actions", ["session_id"])


def downgrade():
    op.drop_index("ix_ui_actions_session_id", table_name="ui_actions")
    op.drop_table("ui_actions")
