"""Store pottery documents, history and confirmed workbench operations."""
from alembic import op
import sqlalchemy as sa

revision = "d64fb2231c10"
down_revision = "c38172f8d9b4"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table("pottery_projects",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("session_id", sa.String(36), sa.ForeignKey("visitor_sessions.id"), nullable=False),
        sa.Column("document", sa.JSON(), nullable=False),
        sa.Column("undo", sa.JSON(), nullable=False), sa.Column("redo", sa.JSON(), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("saved_at", sa.DateTime(), nullable=True),
        sa.Column("updated_at", sa.DateTime(), nullable=False))
    op.create_index("ix_pottery_projects_session_id", "pottery_projects", ["session_id"])
    op.create_table("pottery_commands",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("project_id", sa.String(36), sa.ForeignKey("pottery_projects.id"), nullable=False),
        sa.Column("client_request_id", sa.String(36), nullable=False),
        sa.Column("request_hash", sa.String(64), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(24), nullable=False),
        sa.Column("result", sa.JSON(), nullable=False),
        sa.Column("receipt", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("expires_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("project_id", "client_request_id", name="uq_pottery_command_request"))
    op.create_index("ix_pottery_commands_project_id", "pottery_commands", ["project_id"])


def downgrade():
    op.drop_table("pottery_commands")
    op.drop_table("pottery_projects")
