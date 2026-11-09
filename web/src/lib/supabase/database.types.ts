export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      cv_document_contents: {
        Row: {
          data: Json | null
          document_schema_version: number | null
          encrypted_payload: Json | null
          external_id: string | null
          revision: string | null
          storage_mode: string | null
          time_created: string | null
          time_updated: string | null
          title: string | null
        }
        Insert: {
          data?: Json | null
          document_schema_version?: number | null
          encrypted_payload?: Json | null
          external_id?: string | null
          revision?: never
          storage_mode?: string | null
          time_created?: string | null
          time_updated?: string | null
          title?: string | null
        }
        Update: {
          data?: Json | null
          document_schema_version?: number | null
          encrypted_payload?: Json | null
          external_id?: string | null
          revision?: never
          storage_mode?: string | null
          time_created?: string | null
          time_updated?: string | null
          title?: string | null
        }
        Relationships: []
      }
      cv_document_summaries: {
        Row: {
          document_schema_version: number | null
          external_id: string | null
          revision: string | null
          storage_mode: string | null
          time_created: string | null
          time_updated: string | null
          title: string | null
        }
        Insert: {
          document_schema_version?: number | null
          external_id?: string | null
          revision?: never
          storage_mode?: string | null
          time_created?: string | null
          time_updated?: string | null
          title?: string | null
        }
        Update: {
          document_schema_version?: number | null
          external_id?: string | null
          revision?: never
          storage_mode?: string | null
          time_created?: string | null
          time_updated?: string | null
          title?: string | null
        }
        Relationships: []
      }
      legal_my_acceptances: {
        Row: {
          content_digest: string | null
          document_audit_id: string | null
          document_id: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      admin_ai_disable: { Args: { p_input: Json }; Returns: Json }
      admin_ai_update: { Args: { p_input: Json }; Returns: Json }
      admin_allowed_user_set: { Args: { p_input: Json }; Returns: Json }
      admin_configuration_save: { Args: { p_input: Json }; Returns: Json }
      admin_context: { Args: never; Returns: Json }
      admin_legal_document_save: { Args: { p_input: Json }; Returns: Json }
      admin_member_grant: { Args: { p_input: Json }; Returns: Json }
      admin_member_revoke: { Args: { p_input: Json }; Returns: Json }
      admin_read: { Args: { p_input: Json }; Returns: Json }
      admin_rule_save: { Args: { p_input: Json }; Returns: Json }
      ai_attempt_complete: { Args: { p_input: Json }; Returns: Json }
      ai_attempt_start: { Args: { p_input: Json }; Returns: Json }
      ai_availability: { Args: { p_input: Json }; Returns: Json }
      ai_cancel: { Args: { p_input: Json }; Returns: Json }
      ai_execution_snapshot: { Args: { p_input: Json }; Returns: Json }
      ai_finalize: { Args: { p_input: Json }; Returns: Json }
      ai_quota: { Args: { p_input: Json }; Returns: Json }
      ai_reserve: { Args: { p_input: Json }; Returns: Json }
      app_context: { Args: never; Returns: Json }
      cv_document_convert: { Args: { p_input: Json }; Returns: Json }
      cv_document_create: { Args: { p_input: Json }; Returns: Json }
      cv_document_delete: { Args: { p_input: Json }; Returns: Json }
      cv_document_rename: { Args: { p_input: Json }; Returns: Json }
      cv_document_update: { Args: { p_input: Json }; Returns: Json }
      keep_project_active: { Args: never; Returns: boolean }
      legal_accept_ai: { Args: { p_input: Json }; Returns: Json }
      legal_accept_document: { Args: { p_input: Json }; Returns: Json }
      legal_current: { Args: never; Returns: Json }
      legal_document_read: { Args: { p_input: Json }; Returns: Json }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const

